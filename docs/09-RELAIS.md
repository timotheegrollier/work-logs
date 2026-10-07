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
de fichiers, éditeurs Word / Excel / CSV / texte — c'est le même code (`shared-service.js` côté
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

## Installation réelle (2026-10-07)

VM `timo-claude` (Debian 13, Node 22.23 dans `/usr/local/bin`), nom Tailscale
`worklogs-relais` → **`https://worklogs-relais.tail614cd0.ts.net:8443`** (`tailscale serve`,
réseau Tailscale seul ; Caddy garde le 443 de la VM, en Docker). Montage CIFS de
`00. PROCEDURE` avec `SRVMURGAT\TimothéeG` sur `/mnt/tse-procedures` (automontage systemd),
racine affichée « 00. PROCEDURE » (`WORKLOGS_RELAY_LABEL`). Vérifié depuis le réseau
Tailscale : `/health` sans code ; 401 sans code ou avec un faux ; préliminaire CORS accepté
pour la PWA seule (403 ailleurs) ; avec le code : 17 dossiers listés, un `.docx` de 14 254
octets relu à l'identique, recherche « procedure » → 6 résultats.

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

Journaux : `journalctl -u worklogs-relais -f`. Mise à jour du relais : recopier `api/`, puis
`sudo systemctl restart worklogs-relais`.
