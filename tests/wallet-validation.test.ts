import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsdcStrict, validateVoucher } from '../src/lib/validation.ts';

const escrow='0x1111111111111111111111111111111111111111';
const valid={name:'SpondionPrepaidEscrow',version:'1',chainId:5042,escrow,channelId:'0',requestId:`0x${'11'.repeat(32)}`,units:'3',deadline:'1800000000',signature:`0x${'11'.repeat(65)}`};
for(const amount of ['1e3','1abc','-1','0','0.0000001','','1.2.3']){
  test(`reject invalid USDC amount ${JSON.stringify(amount)} without throwing`,()=>{
    assert.equal(parseUsdcStrict(amount,6).ok,false);
  });
}
test('one micro-USDC stays exact',()=>assert.deepEqual(parseUsdcStrict('0.000001',6),{ok:true,baseUnits:1n,display:'0.000001 USDC = 1 base units'}));
test('amount beyond Number safe integer stays exact',()=>{
  const r=parseUsdcStrict('9007199254.740993',6);
  assert.equal(r.ok,true); if(r.ok) assert.equal(r.baseUnits,9007199254740993n);
});
test('uint256 boundary accepts maximum and rejects overflow',()=>{
  const max=(1n<<256n)-1n;
  const decimal=(n:bigint)=>`${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`;
  const good=parseUsdcStrict(decimal(max),6); assert.equal(good.ok,true); if(good.ok)assert.equal(good.baseUnits,max);
  assert.equal(parseUsdcStrict(decimal(max+1n),6).ok,false);
});
test('full valid voucher round-trips its original channel and domain',()=>{
  const r=validateVoucher(valid,5042,escrow); assert.equal(r.ok,true);
  if(r.ok){assert.equal(r.voucher.channelId,'0');assert.equal(r.voucher.name,valid.name);assert.equal(r.voucher.version,'1');}
});
for(const change of [{requestId:{}},{requestId:'0xab'},{units:3},{units:'0'},{units:'01'},{channelId:'-1'},{deadline:'1e9'},{signature:'0x123'},{chainId:1},{escrow:'0x2222222222222222222222222222222222222222'},{name:'OtherProtocol'},{version:'2'},{name:undefined}]){
 test(`reject malformed voucher ${JSON.stringify(change)}`,()=>assert.equal(validateVoucher({...valid,...change},5042,escrow).ok,false));
}
test('contract-wallet signatures need no EOA-only length assumption',()=>{
  for(const signature of ['0x',`0x${'12'.repeat(120)}`])assert.equal(validateVoucher({...valid,signature},5042,escrow).ok,true);
});
