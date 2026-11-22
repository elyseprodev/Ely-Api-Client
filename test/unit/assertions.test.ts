import { describe, it, expect } from 'vitest';
import { createExpect } from '../../src/scripting/SandboxApi';

/**
 * The scripting sandbox exposes a chai-compatible `pm.expect`. These tests pin the chains that
 * Postman collections use in practice, including the two spellings of type assertions.
 */
describe('pm.expect', () => {
  const e = createExpect as (value: unknown) => any;

  it('supports call-style type assertions', () => {
    expect(() => e([1, 2]).to.be.an('array')).not.toThrow();
    expect(() => e('x').to.be.a('string')).not.toThrow();
    expect(() => e('x').to.be.a('number')).toThrow(/expected "x" to be a number/);
  });

  it('supports property-style type assertions', () => {
    expect(() => e([1, 2]).to.be.an.array).not.toThrow();
    expect(() => e(5).to.be.a.number).not.toThrow();
    expect(() => e(5).to.be.an.array).toThrow(/to be a array/);
  });

  it('supports equality, membership and property checks', () => {
    expect(() => e(1).to.equal(1)).not.toThrow();
    expect(() => e(1).to.equal(2)).toThrow(/expected 1 to equal 2/);
    expect(() => e('abc').to.include('b')).not.toThrow();
    expect(() => e({ a: 1 }).to.have.property('a')).not.toThrow();
    expect(() => e(1).to.be.above(0)).not.toThrow();
  });

  it('supports negation without recursing', () => {
    expect(() => e(1).to.not.equal(2)).not.toThrow();
    expect(() => e(1).to.not.equal(1)).toThrow(/not to equal/);
  });

  it('is callable for the chai property form', () => {
    expect(e(1)()).toBeDefined();
  });
});
