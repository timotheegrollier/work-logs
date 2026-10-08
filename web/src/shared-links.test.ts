import { describe, expect, it } from 'vitest';
import { addressKey, followDir, linkFor, localDir } from './shared-links';

const PC_ROOT = '\\\\172.16.1.20\\d\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE';
const RELAY_ROOT = '\\\\172.16.1.20\\D\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE';
const WHOLE_D = '\\\\SRVMURGAT\\D';

describe('dossier du TSE relié à un projet', () => {
  it('enregistré en adresse complète, retraduit sur un autre appareil (casse, serveur, racine différente)', () => {
    const link = linkFor(PC_ROOT, '2. TSE');
    expect(link).toBe('\\\\172.16.1.20\\d\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE\\2. TSE');
    // Le relais (partage « D » en majuscule) : même dossier.
    expect(localDir(RELAY_ROOT, link)).toBe('2. TSE');
    // Un PC qui monte tout D, par le nom du serveur : le chemin complet sous sa racine.
    expect(localDir(WHOLE_D, link)).toBe('Global/MURGAT INGENIERIE/13. SI/00. PROCEDURE/2. TSE');
    // La racine elle-même : relié à tout le partage.
    expect(localDir(RELAY_ROOT, linkFor(PC_ROOT, ''))).toBe('');
  });

  it('hors de cette racine, ou sans racine connue : pas de dossier ici', () => {
    expect(localDir(RELAY_ROOT, '\\\\172.16.1.20\\D\\Pisciculture')).toBeNull();
    expect(localDir(null, '\\\\172.16.1.20\\D\\Pisciculture')).toBeNull();
    expect(localDir(RELAY_ROOT, null)).toBeNull();
  });

  it('sans adresse (dossier local, tests) : chemin relatif, tel quel', () => {
    expect(linkFor(null, 'Piscine')).toBe('Piscine');
    expect(localDir(null, 'Piscine')).toBe('Piscine');
    expect(localDir(RELAY_ROOT, 'Piscine')).toBe('Piscine');
  });

  it('clé sans serveur ni casse', () => {
    expect(addressKey('\\\\SRVMURGAT\\D\\Global\\Procédures')).toBe(addressKey('//172.16.1.20/d/global/procédures'));
  });
});

describe('dossier relié renommé ou supprimé', () => {
  it('le lien suit le dossier, ou celui au-dessus de lui ; les autres ne bougent pas', () => {
    expect(followDir(RELAY_ROOT, linkFor(PC_ROOT, '2. TSE'), '2. TSE', 'TSE')).toBe(linkFor(RELAY_ROOT, 'TSE'));
    expect(followDir(null, 'Piscine/Filtres', 'Piscine', 'Bassin')).toBe('Bassin/Filtres');
    expect(followDir(null, 'Piscines', 'Piscine', 'Bassin')).toBeUndefined();
    expect(followDir(null, 'Atelier', 'Piscine', 'Bassin')).toBeUndefined();
    expect(followDir(RELAY_ROOT, '\\\\172.16.1.20\\D\\Pisciculture', '2. TSE', 'TSE')).toBeUndefined();
    expect(followDir(null, null, 'Piscine', 'Bassin')).toBeUndefined();
  });

  it('sans casse, comme le partage Windows ; supprimé, le projet n’est plus relié', () => {
    expect(followDir(null, 'procedure/Réseau', 'Procedure', 'Procédures')).toBe('Procédures/Réseau');
    expect(followDir(null, 'Piscine/Filtres', 'Piscine', null)).toBeNull();
    expect(followDir(null, 'Piscine', 'Piscine', null)).toBeNull();
  });
});
