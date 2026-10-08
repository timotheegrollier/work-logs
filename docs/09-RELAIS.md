# Relais du dossier partagé (PWA sur téléphone)

Le téléphone (PWA, servie par le Worker Cloudflare) ne peut pas joindre `\\SRVMURGAT` : un
navigateur ne parle pas SMB et le serveur est sur le réseau du bureau. Le **relais** fait le
lien : il tourne sur la VM `172.16.1.203`, monte le dossier des procédures, et expose les
mêmes routes que le desktop (`/api/shared/*`). Le téléphone le joint **par Tailscale**, en
HTTPS. Décision : `05-DECISIONS.md` §29.

```
téléphone (PWA, https://worklogs-google…workers.dev)
   │  fetch + « Authorization: Bearer <code> »  (CORS : la seule origine de la PWA)
   ▼
https://<vm>.<tailnet>.ts.net:8443   ← tailscale serve (certificat valide, réseau Tailscale seul)
   ▼
127.0.0.1:8420  node api/src/relay.js   (worklogs-relais.service, utilisateur worklogs-relais)
   ▼
/mnt/tse-procedures  ← CIFS : //172.16.1.20/D/Global/MURGAT INGENIERIE/13. SI/00. PROCEDURE
```

Ce qui ne change pas : verrous, envoi gardé, conflits (et « Fusionner »), versions, création
de fichiers, dossiers (créer, renommer, supprimer), éditeurs Word / Excel / CSV / texte — c'est le même code (`shared-service.js` côté
relais, les mêmes composants côté PWA). Ce qui change : la porte d'entrée (un code d'accès au
lieu de « cet ordinateur seulement ») et la base locale (celle du relais, sur la VM).

## Installer (une fois, sur la VM)

Fichiers prêts dans `relay/` : `worklogs-relais.service`, `env.exemple`, `fstab.exemple`,
`smb.cred.exemple`. Il faut Node 22.5 ou plus (`node:sqlite`), `cifs-utils`, Tailscale.

1. **Code** : copier `api/` dans `/opt/worklogs-relais/api`, puis
   `npm install --omit=dev` dans ce dossier.
2. **Utilisateur** : `useradd --system --home /var/lib/worklogs-relais --shell /usr/sbin/nologin worklogs-relais`.
3. **Mot de passe du partage** — **Timo le saisit lui-même** sur la VM, il ne passe par personne :
   `sudo install -m 600 -o root -g root relay/smb.cred.exemple /etc/worklogs-relais/smb.cred`
   puis `sudo nano /etc/worklogs-relais/smb.cred`.
4. **Montage** : ligne de `fstab.exemple` dans `/etc/fstab`, `sudo mkdir -p /mnt/tse-procedures`,
   `sudo systemctl daemon-reload && sudo mount /mnt/tse-procedures && ls /mnt/tse-procedures`.
5. **Réglages** : `env.exemple` → `/etc/worklogs-relais/env` (root:worklogs-relais, 0640) ;
   code d'accès : `node /opt/worklogs-relais/api/src/relay.js --nouveau-code | sudo tee /etc/worklogs-relais/code`,
   puis `sudo chown root:worklogs-relais /etc/worklogs-relais/code && sudo chmod 640 /etc/worklogs-relais/code`.
6. **Service** : `worklogs-relais.service` → `/etc/systemd/system/`, `sudo systemctl enable --now worklogs-relais`,
   `curl -s http://127.0.0.1:8420/health`.
7. **Tailscale** : installer depuis le dépôt officiel (`pkgs.tailscale.com`), `sudo tailscale up`
   (Timo ouvre l'adresse affichée pour ajouter la VM à son réseau), puis
   `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8420`. Il faut « HTTPS Certificates »
   activé dans la console Tailscale (DNS). Le port 8443 évite Caddy, qui tient déjà le 443 de la VM.
8. **Mise à jour automatique** (section suivante) : `relay/mise-a-jour.mjs` →
   `/opt/worklogs-relais/mise-a-jour.mjs` (root, 0644) ; la version copiée à l'étape 1 dans
   `/opt/worklogs-relais/api/VERSION` (`echo X.Y.Z | sudo tee …`) ; `worklogs-relais-maj.service`
   et `worklogs-relais-maj.timer` → `/etc/systemd/system/`, puis
   `sudo systemctl daemon-reload && sudo systemctl enable --now worklogs-relais-maj.timer`.
   `ExecStart` passe par `/usr/bin/env node` : rien à changer si Node est dans `/usr/local/bin`.

## Mise à jour automatique

Le relais suit tout seul les **releases publiées** de WorkLogs, celles que la CI a validées :
`worklogs-relais-maj.timer` lance `/opt/worklogs-relais/mise-a-jour.mjs` (copie de
`relay/mise-a-jour.mjs`) toutes les 5 minutes, en root. Une release arrive donc sur le relais
5 minutes au plus après sa publication. Décision : `05-DECISIONS.md` §37.

À chaque passage, une requête à l'API GitHub (`releases/latest`) ; si la release est plus
récente que `api/VERSION` :
1. **préparer à côté** (`/opt/worklogs-relais/.maj-X.Y.Z/`) : archive du tag,
   `npm ci --omit=dev --ignore-scripts`, le module du relais doit se charger. Un échec ici ne
   touche à rien ; c'est retenté au passage suivant ;
2. **basculer** : relais arrêté, base sauvegardée (`/var/lib/worklogs-relais-maj/base-avant-maj/`),
   `api` → `api.precedent`, nouveau code en place avec son `VERSION`, relais relancé ;
3. **vérifier** : `/health` doit répondre **avec la nouvelle version** dans les 30 s ;
4. sinon **retour arrière** (code et base), et cette version est **écartée** : le relais n'est
   plus coupé pour elle, la release suivante sera essayée normalement.

Rien n'est tenté si le relais ne répond pas déjà (partage démonté, VM qui redémarre). Après
une mise à jour réussie, le script de la release remplace celui de la VM et
`/opt/worklogs-relais/DEPLOIEMENT.txt` est réécrit ; les unités systemd, elles, ne changent
pas toutes seules.

| Pour… | Sur la VM, en root |
|---|---|
| savoir quelle version tourne | `curl -s http://127.0.0.1:8420/health` → `"version"` (aussi par l'adresse Tailscale) |
| voir les derniers passages | `journalctl -u worklogs-relais-maj -n 20` ; `systemctl list-timers worklogs-relais-maj.timer` |
| savoir s'il y a du nouveau, sans rien faire | `node /opt/worklogs-relais/mise-a-jour.mjs --simuler` |
| mettre à jour tout de suite | `systemctl start worklogs-relais-maj` |
| réessayer une version écartée | `rm /var/lib/worklogs-relais-maj/etat.json && systemctl start worklogs-relais-maj` |
| garder une version à la main | `systemctl disable --now worklogs-relais-maj.timer` (sinon elle est remplacée au passage suivant) |
| revenir à la version d'avant | les commandes de `/opt/worklogs-relais/DEPLOIEMENT.txt` |

## Installation réelle (2026-10-07)

VM `timo-claude` (Debian 13, Node 22.23 dans `/usr/local/bin`), nom Tailscale
`worklogs-relais` → **`https://worklogs-relais.tail614cd0.ts.net:8443`** (`tailscale serve`,
réseau Tailscale seul ; Caddy garde le 443 de la VM, en Docker). Montage CIFS de
`00. PROCEDURE` avec `SRVMURGAT\TimothéeG` sur `/mnt/tse-procedures` (automontage systemd),
racine affichée « 00. PROCEDURE » (`WORKLOGS_RELAY_LABEL`). Vérifié depuis le réseau
Tailscale : `/health` sans code ; 401 sans code ou avec un faux ; préliminaire CORS accepté
pour la PWA seule (403 ailleurs) ; avec le code : 17 dossiers listés, un `.docx` de 14 254
octets relu à l'identique, recherche « procedure » → 6 résultats.

**Mis à jour le 2026-10-08** (la PWA 0.51.0 répondait « Introuvable. » en créant un dossier : le
relais datait d'avant la v0.49.0). Déployé, au choix de Timo : le code de la **v0.51.0**
(`6b299df` : dossiers, suppression de fichier) **plus le travail non commité** de la copie
`worklogs-file-coedition-bcae02` qui tournait déjà sur la VM (adresse du dossier portée par le
projet, `shared-address.js`, colonne `projects.shared_dir`), fusionné à la main — **ce mélange
n'est dans aucun commit** ; la prochaine release publiée le remplace (mise à jour automatique,
ci-dessous) — avec ce travail seulement s'il est fusionné d'ici là.
Tests API sur ce code : 255/255. Seul `api/src` a changé (dépendances identiques). Ancien code :
`/opt/worklogs-relais/api.bak-20261008-150339` ; composition et retour arrière :
`/opt/worklogs-relais/DEPLOIEMENT.txt`. Vérifié sur la VM : routes des dossiers et de la
suppression présentes, chemin hors du partage refusé, statut `ok`, préliminaire CORS 204.

**Mise à jour automatique installée le 2026-10-08** (§37). Essayée d'abord sur une **copie**
du relais (port 8421, base et dossier à elle, retirée ensuite), avec le vrai script dans une
unité aux mêmes protections que `worklogs-relais-maj.service` : une « v0.51.1 » (le code de
cette branche) installée en 2 s, `npm ci` et `systemctl` depuis l'unité compris, `/health` →
`"version":"0.51.1"`, base sauvegardée avec son propriétaire ; puis une « v0.51.3 » qui ne
répond pas (l'archive GitHub de la v0.51.0, dont `/health` ne dit pas sa version) : retour
arrière après 30 s, « v0.51.1 répond de nouveau », version écartée, et le passage suivant ne
relance pas le relais. Sur le vrai relais : `api/VERSION` = `0.51.0` pour le mélange ci-dessus,
minuteur activé, premier passage « À jour : v0.51.0. ».

**Premier vrai passage, le même jour** : la v0.52.0, publiée à 16:31, a été installée par le
minuteur à 16:33 — elle a démarré, mais son `/health` ne disait pas encore sa version (le lot
de la mise à jour automatique n'y était pas) : refusée au bout de 30 s, retour arrière,
« v0.51.0 répond de nouveau », et le passage de 16:38 ne l'a pas retentée. Deux redémarrages
d'une seconde ; le relais a répondu tout du long.

**La v0.54.0, première gardée** : publiée à 17:20:30, installée d'elle-même à 17:23:41 —
`/health` → `"version":"0.54.0"` (en local et par Tailscale), statut `ok`, 19 éléments à la
racine du partage, 401 sans code ; le script de la VM est celui de la release,
`DEPLOIEMENT.txt` réécrit, l'ancien code (mélange du matin) dans `api.precedent`.

## Régler le téléphone

1. Tailscale allumé sur le téléphone (le même réseau que la VM).
2. WorkLogs (PWA) › Paramètres › **Dossier partagé du TSE** : adresse
   `https://<vm>.<tailnet>.ts.net:8443`, code d'accès (le contenu de `/etc/worklogs-relais/code`).
   Pour ne pas le recopier à la main : sur la VM, en root, `qrencode -t ansiutf8 < /etc/worklogs-relais/code`,
   le scanner avec l'appareil photo du téléphone, copier le texte, le coller dans le champ.
   « Enregistrer » vérifie aussitôt que le relais répond. Si Chrome demande l'accès au réseau
   local, l'accepter (adresse Tailscale privée).
3. La section « Dossier partagé » apparaît dans la colonne Procédures.

Le code reste sur ce téléphone (stockage de la PWA), jamais synchronisé par Drive. Changer de
code : en générer un nouveau sur la VM, `sudo systemctl restart worklogs-relais`, le ressaisir.

## Quand ça ne marche pas

| Ce qu'on voit | Où regarder |
|---|---|
| « Le relais du dossier partagé ne répond pas » | Tailscale allumé sur le téléphone ? `systemctl status worklogs-relais`, `tailscale serve status` sur la VM |
| « code d’accès absent ou incorrect » | le code du téléphone = `/etc/worklogs-relais/code` ? |
| « Non monté » / « Injoignable » | `ls /mnt/tse-procedures` sur la VM ; mot de passe du compte changé → mettre à jour `smb.cred` |
| Erreur CORS dans la console du téléphone | `WORKLOGS_RELAY_ORIGINS` = l'adresse exacte de la PWA |
| « Accès refusé » sur un dossier | droits NTFS du compte de `smb.cred` sur ce dossier |
| « Introuvable. » sur un geste récent (le relais n'a pas la route) | version de `/health` ≠ celle de la PWA ? `journalctl -u worklogs-relais-maj` : release écartée, relais injoignable au passage, GitHub qui refuse… |

Journaux : `journalctl -u worklogs-relais -f`, et pour la mise à jour automatique
`journalctl -u worklogs-relais-maj`.
