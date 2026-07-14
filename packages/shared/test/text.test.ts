import { describe, expect, it } from 'vitest';
import {
  diceCoefficient,
  emailDomain,
  extractEmails,
  isGenericSubject,
  normalizeDomain,
  normalizeEntityName,
  normalizeSubject,
  normalizeText,
  parseHost,
} from '../src/text';

describe('normalizeText', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeText('  Açme,  Inc. ')).toBe('acme inc');
  });
});

describe('normalizeDomain', () => {
  it('strips protocol, www, path', () => {
    expect(normalizeDomain('https://www.BrightKidsCo.example/path?x=1')).toBe('brightkidsco.example');
  });
});

describe('emailDomain', () => {
  it('returns the normalized domain', () => {
    expect(emailDomain('Robin@BrightKidsCo.example')).toBe('brightkidsco.example');
  });
});

describe('extractEmails', () => {
  it('pulls all addresses out of free text', () => {
    expect(extractEmails('to a@b.com and C@D.COM')).toEqual(['a@b.com', 'c@d.com']);
  });
});

describe('parseHost', () => {
  it('extracts host from a URL', () => {
    expect(parseHost('https://app.financial-cents.com/clients/123')).toBe('app.financial-cents.com');
  });
});

describe('normalizeEntityName', () => {
  it('drops legal suffixes and the leading "the"', () => {
    expect(normalizeEntityName('The Beacon Group LLC').tokens).toEqual(['beacon']);
  });
});

describe('diceCoefficient', () => {
  it('scores identical strings as 1 and disjoint as low', () => {
    expect(diceCoefficient('summit tire', 'summit tire')).toBe(1);
    expect(diceCoefficient('summit', 'zzzzz')).toBeLessThan(0.2);
  });
});

describe('isGenericSubject', () => {
  it('flags subjects with no distinctive token (email chrome / CPA-universal words)', () => {
    expect(isGenericSubject(normalizeSubject('Re: Tax question'))).toBe(true);
    expect(isGenericSubject(normalizeSubject('quick question'))).toBe(true);
    expect(isGenericSubject(normalizeSubject('Fwd: documents'))).toBe(true);
    expect(isGenericSubject(normalizeSubject('monthly financials'))).toBe(true);
  });
  it('keeps subjects carrying a distinctive token (a name/entity)', () => {
    expect(isGenericSubject(normalizeSubject('Re: Nimbus Tax'))).toBe(false);
    expect(isGenericSubject(normalizeSubject('Northwind financials'))).toBe(false);
    expect(isGenericSubject(normalizeSubject('Acme update'))).toBe(false);
  });
});
