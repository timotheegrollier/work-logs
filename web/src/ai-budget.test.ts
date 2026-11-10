import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  aiBudgetRefusal, aiResetTime, aiUsageLabel, DEFAULT_DAILY_REQUESTS, estimateTokens, MAX_DAILY_REQUESTS,
  MIN_DAILY_REQUESTS, nextAiReset, pacificDay, readAiUsage, readDailyLimit, recordAiUsage, saveDailyLimit,
  TOKENS_PER_REQUEST,
  type AiUsage,
} from './ai-budget';

const USAGE = 'worklogs-ai-usage';
const LIMIT = 'worklogs-ai-daily-limit';
const seed = (usage: Partial<AiUsage>) =>
  localStorage.setItem(USAGE, JSON.stringify({ day: pacificDay(), requests: 0, tokens: 0, background: 0, ...usage }));
const zero = (day = pacificDay()) => ({ day, requests: 0, tokens: 0, background: 0 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('jour du quota', () => {
  test('le jour change à minuit à Los Angeles, en heure d’hiver comme en heure d’été', () => {
    expect(pacificDay(new Date('2026-11-09T07:59:59Z'))).toBe('2026-11-08');
    expect(pacificDay(new Date('2026-11-09T08:00:00Z'))).toBe('2026-11-09');
    expect(pacificDay(new Date('2026-07-01T06:59:59Z'))).toBe('2026-06-30');
    expect(pacificDay(new Date('2026-07-01T07:00:00Z'))).toBe('2026-07-01');
  });

  test.each([
    ['heure d’hiver', '2026-11-09T12:00:00Z', '2026-11-10T08:00:00.000Z'],
    ['heure d’été', '2026-07-01T12:00:00Z', '2026-07-02T07:00:00.000Z'],
    ['passage à l’heure d’été', '2026-03-07T20:00:00Z', '2026-03-08T08:00:00.000Z'],
    ['lendemain du passage à l’été', '2026-03-08T20:00:00Z', '2026-03-09T07:00:00.000Z'],
    ['passage à l’heure d’hiver', '2026-10-31T20:00:00Z', '2026-11-01T07:00:00.000Z'],
    ['lendemain du passage à l’hiver', '2026-11-01T20:00:00Z', '2026-11-02T08:00:00.000Z'],
    ['fin d’année', '2026-12-31T12:00:00Z', '2027-01-01T08:00:00.000Z'],
    ['juste avant minuit', '2026-11-09T07:59:59Z', '2026-11-09T08:00:00.000Z'],
    ['à minuit pile', '2026-11-09T08:00:00Z', '2026-11-10T08:00:00.000Z'],
  ])('prochain minuit : %s', (_name, now, reset) => {
    expect(nextAiReset(new Date(now)).toISOString()).toBe(reset);
  });

  test('l’heure annoncée est l’heure locale de ce minuit', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const reset = nextAiReset(now);
    expect(aiResetTime(now)).toBe(`${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`);
  });

  test('le compteur repart de zéro au changement de jour Pacifique, pas à minuit local', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T07:00:00Z') });
    recordAiUsage(1000, false);
    recordAiUsage(500, true);
    expect(readAiUsage()).toEqual({ day: '2026-11-08', requests: 2, tokens: 1500, background: 1 });
    vi.setSystemTime(new Date('2026-11-09T07:59:59Z'));
    expect(readAiUsage().requests).toBe(2);
    vi.setSystemTime(new Date('2026-11-09T08:00:00Z'));
    expect(readAiUsage()).toEqual(zero('2026-11-09'));
    recordAiUsage(10, false);
    expect(readAiUsage()).toEqual({ day: '2026-11-09', requests: 1, tokens: 10, background: 0 });
  });
});

describe('refus', () => {
  const requests = (count: string) => `Plafond quotidien d’IA atteint sur cet appareil (${count} requêtes) : il revient à ${aiResetTime()}, ou relève-le dans ⚙ Paramètres.`;
  const tokens = (count: string) => `Plafond quotidien d’IA atteint sur cet appareil (${count} jetons) : il revient à ${aiResetTime()}, ou relève-le dans ⚙ Paramètres.`;
  const automatic = 'Actualisation automatique suspendue pour aujourd’hui : elle ne prend qu’un tiers du plafond quotidien. « Actualiser » reste disponible.';

  test('plafond de requêtes : refus au plafond exact, pour tous les gestes', () => {
    seed({ requests: DEFAULT_DAILY_REQUESTS - 1 });
    expect(aiBudgetRefusal(false)).toBeNull();
    seed({ requests: DEFAULT_DAILY_REQUESTS });
    expect(aiBudgetRefusal(false)).toBe(requests('150'));
    expect(aiBudgetRefusal(true)).toBe(requests('150'));
  });

  test('plafond de jetons : requêtes × volume, avec les milliers espacés', () => {
    expect(TOKENS_PER_REQUEST).toBe(10_000);
    seed({ tokens: 1_499_999 });
    expect(aiBudgetRefusal(false)).toBeNull();
    seed({ tokens: 1_500_000 });
    expect(aiBudgetRefusal(false)).toBe(tokens('1 500 000'));
  });

  test('un plafond enregistré change les deux seuils', () => {
    saveDailyLimit(MIN_DAILY_REQUESTS);
    seed({ requests: 10 });
    expect(aiBudgetRefusal(false)).toBe(requests('10'));
    seed({ tokens: 100_000 });
    expect(aiBudgetRefusal(false)).toBe(tokens('100 000'));
    saveDailyLimit(4000);
    seed({ requests: 3999, tokens: 39_999_999 });
    expect(aiBudgetRefusal(false)).toBeNull();
    seed({ requests: 4000 });
    expect(aiBudgetRefusal(false)).toBe(requests('4 000'));
  });

  test('l’automatique s’arrête au tiers du plafond ; les gestes explicites continuent', () => {
    seed({ background: 49 });
    expect(aiBudgetRefusal(true)).toBeNull();
    seed({ background: 50 });
    expect(aiBudgetRefusal(true)).toBe(automatic);
    expect(aiBudgetRefusal(false)).toBeNull();
    saveDailyLimit(10); // tiers arrondi au-dessus : 4
    seed({ background: 3 });
    expect(aiBudgetRefusal(true)).toBeNull();
    seed({ background: 4 });
    expect(aiBudgetRefusal(true)).toBe(automatic);
  });

  test('le plafond atteint prime sur la suspension de l’automatique', () => {
    seed({ requests: 150, background: 150 });
    expect(aiBudgetRefusal(true)).toBe(requests('150'));
  });
});

describe('compteur', () => {
  test('chaque appel ajoute une requête, ses jetons et, s’il est automatique, une part de fond', () => {
    expect(readAiUsage()).toEqual(zero());
    recordAiUsage(100, false);
    recordAiUsage(200, true);
    expect(readAiUsage()).toEqual({ ...zero(), requests: 2, tokens: 300, background: 1 });
  });

  test('estimation de jetons : un pour quatre caractères, arrondi au-dessus', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  test('libellé du jour', () => {
    seed({ requests: 12, tokens: 18_400 });
    expect(aiUsageLabel()).toBe('Aujourd’hui : 12 / 150 requêtes · ≈ 18 400 jetons');
  });
});

describe('stockage', () => {
  test.each([
    ['localStorage refuse', () => {
      const refuse = () => { throw new DOMException('refusé', 'SecurityError'); };
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    }],
    ['localStorage absent', () => vi.stubGlobal('localStorage', undefined)],
  ])('%s : valeurs par défaut, aucune exception', (_name, breakStorage) => {
    breakStorage();
    expect(readAiUsage()).toEqual(zero());
    expect(readDailyLimit()).toBe(DEFAULT_DAILY_REQUESTS);
    expect(() => recordAiUsage(10, true)).not.toThrow();
    expect(() => saveDailyLimit(20)).not.toThrow();
    expect(aiBudgetRefusal(true)).toBeNull();
    expect(aiUsageLabel()).toBe('Aujourd’hui : 0 / 150 requêtes · ≈ 0 jetons');
  });

  test.each([
    '{', 'null', '5', '[]', '""',
    JSON.stringify({ requests: 5, tokens: 1, background: 0 }),
    JSON.stringify({ day: 'hier', requests: 5, tokens: 1, background: 0 }),
  ])('compteur illisible %s : zéro', (value) => {
    localStorage.setItem(USAGE, value);
    expect(readAiUsage()).toEqual(zero());
  });

  test.each([
    { requests: '12' }, { requests: -1 }, { requests: null }, { tokens: 'beaucoup' }, { tokens: -5 }, { background: {} },
  ])('compteur corrompu %j : zéro', (fields) => {
    seed({ requests: 3, tokens: 3, background: 3, ...(fields as Partial<AiUsage>) });
    expect(readAiUsage()).toEqual(zero());
  });

  test('un compteur corrompu est réécrit proprement au prochain appel', () => {
    localStorage.setItem(USAGE, '{');
    recordAiUsage(10, false);
    expect(readAiUsage()).toEqual({ ...zero(), requests: 1, tokens: 10 });
  });

  test.each(['abc', '', 'NaN', 'Infinity', '{}', '12abc'])('plafond illisible « %s » : défaut', (value) => {
    localStorage.setItem(LIMIT, value);
    expect(readDailyLimit()).toBe(DEFAULT_DAILY_REQUESTS);
  });
});

describe('bornes du plafond', () => {
  test('défaut, borne basse, borne haute et arrondi', () => {
    expect(readDailyLimit()).toBe(150);
    saveDailyLimit(1);
    expect(readDailyLimit()).toBe(MIN_DAILY_REQUESTS);
    saveDailyLimit(99_999);
    expect(readDailyLimit()).toBe(MAX_DAILY_REQUESTS);
    saveDailyLimit(200.4);
    expect(readDailyLimit()).toBe(200);
    saveDailyLimit(MIN_DAILY_REQUESTS);
    expect(readDailyLimit()).toBe(10);
    saveDailyLimit(MAX_DAILY_REQUESTS);
    expect(readDailyLimit()).toBe(5000);
  });

  test('une valeur saisie invalide retombe sur le défaut', () => {
    saveDailyLimit(Number.NaN);
    expect(readDailyLimit()).toBe(DEFAULT_DAILY_REQUESTS);
  });

  test('une valeur écrite hors bornes est ramenée dans les bornes à la lecture', () => {
    localStorage.setItem(LIMIT, '3');
    expect(readDailyLimit()).toBe(10);
    localStorage.setItem(LIMIT, '99999');
    expect(readDailyLimit()).toBe(5000);
    localStorage.setItem(LIMIT, '-20');
    expect(readDailyLimit()).toBe(10);
  });
});
