import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { beforeEach, onTestFinished } from 'vitest';

// Démontage par `onTestFinished`, pas par `afterEach` : dès qu'un `afterEach` lève,
// vitest saute ceux qui restent, et un `afterEach` déclaré ici passe après ceux du
// fichier (ordre « stack »). Un test fautif laissait alors son écran monté sous tous
// les suivants (« Found multiple elements… Journal »). `onTestFinished` est joué
// après les `afterEach`, même quand l'un d'eux lève.
beforeEach(() => { onTestFinished(cleanup); });
