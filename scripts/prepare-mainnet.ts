/** Creates unsigned deployment data. No signer, wallet key or broadcast path. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeAbiParameters, encodeDeployData, formatUnits, http, isAddress, keccak256, toBytes, type Abi, type Address } from 'viem';
import { parseUint256Strict } from '../src/lib/validation';

const args=process.argv.slice(2);
const values=new Map<string,string>(); let estimate=false;
for(let i=0;i<args.length;i++){
  const flag=args[i];
  if(flag==='--estimate'){estimate=true;continue;}
  if(!['--grace','--from','--out'].includes(flag??'') || !args[i+1])throw new Error('Options: --grace SECONDS --out FILE [--from PUBLIC_ADDRESS --estimate]');
  values.set(flag!,args[++i]!);
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(resolve(root,'contracts/SpondionPrepaidEscrow.sol'),'utf8');
const artifact=JSON.parse(readFileSync(resolve(root,'contracts/out/SpondionPrepaidEscrow.sol/SpondionPrepaidEscrow.json'),'utf8'));
const metadata=typeof artifact.metadata==='string'?JSON.parse(artifact.metadata):artifact.metadata;
if(!metadata?.compiler?.version?.startsWith('0.8.28+'))throw new Error('Rebuild with the reviewed Solc0.8.28 compiler');
if(metadata.sources?.['contracts/SpondionPrepaidEscrow.sol']?.keccak256!==keccak256(toBytes(source)))throw new Error('Artifact does not match source; rebuild contracts first');
const grace=parseUint256Strict(values.get('--grace')??'300','Grace',1n);
if(grace>2592000n)throw new Error('Grace must be between1second and30days');
const usdc='0x3600000000000000000000000000000000000000' as const;
const bytecode=artifact.bytecode.object as `0x${string}`;
if(!/^0x[0-9a-f]+$/i.test(bytecode))throw new Error('Bytecode is not fully linked');
const data=encodeDeployData({abi:artifact.abi as Abi,bytecode,args:[usdc,grace]});
const decoded=decodeAbiParameters([{type:'address'},{type:'uint256'}],`0x${data.slice(bytecode.length)}`);
if(decoded[0].toLowerCase()!==usdc || decoded[1]!==grace)throw new Error('Constructor encoding check failed');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const from=values.get('--from');
if(from && (!isAddress(from) || /^0x0{40}$/i.test(from)))throw new Error('--from must be the public address of a real user-controlled deployer');
if(estimate && !from)throw new Error('--estimate requires --from PUBLIC_ADDRESS; no private key is used');
let feeEstimate:unknown=null;
if(estimate){
  const client=createPublicClient({transport:http('https://rpc.mainnet.arc.io')});
  if(await client.getChainId()!==5042)throw new Error('RPC is not Arc Mainnet');
  const decimals=await client.readContract({address:usdc,abi:[{type:'function',name:'decimals',stateMutability:'view',inputs:[],outputs:[{type:'uint8'}]}],functionName:'decimals'});
  if(decimals!==6)throw new Error('Official USDC decimal check failed');
  const [gas,gasPrice]=await Promise.all([client.estimateGas({account:from as Address,data,value:0n}),client.getGasPrice()]);
  feeEstimate={checkedAt:new Date().toISOString(),gas:gas.toString(),gasPrice:gasPrice.toString(),approximateUSDC:formatUnits(gas*gasPrice,18),note:'Estimate only; user must review a fee cap and personally confirm the final wallet transaction.'};
}
const result={status:'UNSIGNED — NOT SENT',chain:'Arc Mainnet',constructor:{usdc,graceSeconds:grace.toString()},compiler:metadata.compiler.version,sourceSHA256:sha(source),bytecodeSHA256:sha(bytecode),creationDataSHA256:sha(data),transaction:{chainId:'0x13b2',...(from?{from}:{}),value:'0x0',data},feeEstimate,approvalRequired:true};
const json=JSON.stringify(result,null,2)+'\n';
if(values.has('--out'))writeFileSync(resolve(values.get('--out')!),json); else process.stdout.write(json);
