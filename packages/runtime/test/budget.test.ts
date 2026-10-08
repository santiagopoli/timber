import {describe, expect, it} from 'vitest';
import {parseRuntimeLimit} from '../src/budget.js';

describe('operator-configured task budgets',()=>{
  it('keeps omitted, empty, null and zero budgets uncapped',()=>{
    for(const value of [undefined,null,'','  ',0,'0'])expect(parseRuntimeLimit(value,'LIMIT')).toBeNull();
  });
  it('accepts positive integers without the former hidden 100/200 ceilings',()=>{
    for(const value of [1,250,1000,' 1000 '])expect(parseRuntimeLimit(value,'LIMIT')).toBe(Number(value));
  });
  it('rejects invalid settings instead of silently disabling or changing the cap',()=>{
    for(const value of [-1,1.5,NaN,Infinity,'invalid','2.5','1e3',Number.MAX_SAFE_INTEGER+1]){
      expect(()=>parseRuntimeLimit(value,'BOTSPACE_MAX_GENERATIONS')).toThrow('BOTSPACE_MAX_GENERATIONS must be a nonnegative safe integer');
    }
  });
});
