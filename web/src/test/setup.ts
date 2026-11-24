import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { beforeEach, onTestFinished, vi } from 'vitest';

// Démontage par `onTestFinished`, pas par `afterEach` : dès qu'un `afterEach` lève,
// vitest saute ceux qui restent, et un `afterEach` déclaré ici passe après ceux du
// fichier (ordre « stack »). Un test fautif laissait alors son écran monté sous tous
// les suivants (« Found multiple elements… Journal »). `onTestFinished` est joué
// après les `afterEach`, même quand l'un d'eux lève.
beforeEach(() => { onTestFinished(cleanup); });

// Le tableau des quotas lit le Worker en ligne : hors de son propre test, rien ne part sur le
// réseau et il reste « en lecture ». `vi.mocked(readAiStatus)` le pilote dans `AiQuotas.test.tsx`.
vi.mock('../ai-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai-status')>()),
  readAiStatus: vi.fn(() => new Promise(() => {})),
}));
