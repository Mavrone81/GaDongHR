import { flattenBundle } from './flattenBundle';

describe('flattenBundle', () => {
  it('flattens nested keys with a dot path', () => {
    expect(flattenBundle({ shell: { brand: 'GaDongHR', locale: { th: 'ไทย' } } })).toEqual({
      'shell.brand': 'GaDongHR',
      'shell.locale.th': 'ไทย',
    });
  });

  it('throws naming the offending path for a non-string leaf', () => {
    expect(() => flattenBundle({ shell: { brand: 42 } })).toThrow(/shell\.brand/);
  });

  it('throws for an array value', () => {
    expect(() => flattenBundle({ shell: [] })).toThrow(/shell/);
  });

  it('root must be an object', () => {
    expect(() => flattenBundle('not an object')).toThrow();
  });
});
