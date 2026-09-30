# Angel OS — guide de lancement de la bêta (en local)

But : faire tourner Angel OS **sur ta machine**, l'ouvrir dans le navigateur et vérifier que ça marche. Rien à déployer sur le VPS, rien à pousser sur GitHub, BlackOS n'est pas concerné.

> **À savoir avant de commencer** : aucun modèle de langage n'est branché. Tout le cockpit marche à la main (formulaires). L'écran **Capture** répondra « aucun interprète n'est connecté » — c'est normal, ce n'est pas une panne. Voir §7.

---

## 1. Ce qu'il te faut
- Node.js **20 ou plus** (`node -v`)
- PostgreSQL **16** qui tourne
- Ce dépôt (`angel-os`), avec `npm install` déjà fait

## 2. Préparer l'environnement (une seule fois)
```bash
cd angel-os
cp .env.example .env
```
Ouvre `.env` et vérifie ces lignes (les autres peuvent rester vides pour la bêta) :
```
DATABASE_URL="postgresql://angel:angel@localhost:5432/angel_os?schema=public"
ANGEL_OS_CREDENTIAL_ENCRYPTION_KEY="<64 caractères hexadécimaux>"    # génère-la avec : openssl rand -hex 32
ANGEL_OS_SYSTEM_PRINCIPAL_ID=00000000-0000-0000-0000-000000000001
```
Crée la base si elle n'existe pas (adapte utilisateur/mot de passe) :
```bash
createdb angel_os        # ou via psql : CREATE DATABASE angel_os;
```

> **Dans chaque nouveau terminal** que tu ouvres pour Angel OS, charge d'abord le `.env` :
> `set -a; . ./.env; set +a`

## 3. Créer les tables et tes données de départ (une seule fois)
```bash
set -a; . ./.env; set +a
npx prisma migrate deploy      # crée les tables
npx prisma generate
npm run db:seed                # crée « Angel » (id 0000…0001) et ses permissions
npm run build
```
✅ Attendu : « All migrations have been successfully applied » puis « Seeded principal 00000000-… ».

## 4. Créer les deux secrets du cockpit (une seule fois)
**a) Le jeton du cockpit** (affiché **une seule fois**, note-le) :
```bash
npm run identity -- create-token 00000000-0000-0000-0000-000000000001 GUIDEHUB cockpit
```
Ça affiche une ligne qui commence par `aos_…` : c'est ton `GUIDEHUB_API_TOKEN`.

**b) Ton mot de passe de connexion** (12 caractères minimum, saisie masquée) :
```bash
npm run guidehub:password
```
Ça affiche `scrypt$…` : c'est ton `GUIDEHUB_PASSWORD_HASH`. Le mot de passe lui-même n'est stocké nulle part : garde-le dans ton gestionnaire de mots de passe.

> Ne mets jamais ces valeurs dans Git. Ne les colle pas dans un chat.

## 5. Lancer (deux terminaux, à chaque session de test)
**Terminal 1 — l'API**
```bash
cd angel-os && set -a; . ./.env; set +a
npm start
```
✅ « Angel OS API listening on http://localhost:3000 ». Test rapide : `curl http://localhost:3000/health` → `{"status":"ok"…}`.

**Terminal 2 — le cockpit**
```bash
cd angel-os && set -a; . ./.env; set +a
GUIDEHUB_API_TOKEN='aos_…' \
GUIDEHUB_PASSWORD_HASH='scrypt$…' \
GUIDEHUB_API_URL=http://localhost:3000 \
GUIDEHUB_INSECURE_COOKIES=1 \
npm run guidehub
```
(`GUIDEHUB_INSECURE_COOKIES=1` n'est là que parce que tu travailles en `http://` local. Ne jamais l'utiliser en ligne.)

Ouvre **http://127.0.0.1:3100** et connecte-toi avec ton mot de passe.

## 6. Checklist de la bêta — ce que tu peux vérifier à la main
Coche au fur et à mesure. Chaque ligne = quelque chose qui doit marcher.

**Aujourd'hui**
- [ ] La page d'accueil (« Aujourd'hui ») s'affiche sans erreur.
- [ ] Tu peux poser une question dans « Ask Jarvis » : `add task Acheter du lait`, puis `what are my tasks`.

**Life** (visions, objectifs, projets, quêtes, tâches)
- [ ] Créer un objectif, puis un projet lié, puis une tâche dans ce projet.
- [ ] Terminer la tâche ; elle apparaît comme faite.

**Décisions**
- [ ] Enregistrer une décision (avec options, pourquoi, résultat attendu, date de bilan).
- [ ] Vérifier qu'il n'existe **aucun bouton pour la modifier** (c'est voulu : une décision est de l'historique).
- [ ] Faire le bilan : attendu vs réel, une seule fois.

**Futur Soi**
- [ ] Créer une aspiration (état actuel, écart, état voulu).
- [ ] Essayer d'enregistrer un nouvel état **sans preuve** → refusé avec un message clair.
- [ ] Ajouter une preuve (un résultat ou une expérience vécue) → l'état s'enregistre, l'historique garde l'ancien.
- [ ] Aucun pourcentage, aucun score n'apparaît.

**Apprentissage**
- [ ] Créer un objectif d'apprentissage, une expérience (hypothèse + méthode), ajouter une observation.
- [ ] Essayer de passer l'expérience à « confirmée » trop tôt → le serveur explique ce qui manque.

**Sécurité / confort**
- [ ] « Déconnexion », puis rechargement : tu dois te reconnecter.
- [ ] Téléphone : ouvre l'adresse depuis un navigateur en réduisant la fenêtre → pas de défilement horizontal.
- [ ] Mode sombre (réglage de ton système) : lisible.

**Capture**
- [ ] L'écran répond « Aucun interprète n'est connecté » (attendu tant que §7 n'est pas fait).

Si quelque chose ne marche pas : note *l'écran*, *ce que tu as fait*, *le message* — c'est tout ce qu'il faut pour le corriger.

## 7. Ce qui manque encore (honnêtement)
| Sujet | Où on en est |
|---|---|
| **Comprendre tes phrases** (Capture / Jarvis) | Le circuit est prêt (brouillon → tu confirmes → enregistré), mais **aucun modèle n'est branché**. À décider ensemble : quel modèle, où ranger la clé, quelle limite de dépense. |
| « remember that … » | Enregistre tout comme un *fait*, même une expérience vécue. À corriger avec la Capture. |
| « Qu'est-ce qui compte aujourd'hui / la semaine prochaine ? » | Non compris par Jarvis (rien n'est inventé). Le cockpit « Aujourd'hui » sert de substitut. |
| Résumé de la semaine | Ne compte que les événements qui écrivent de l'activité (observations, leçons, résultats n'en écrivent pas encore). |
| Déploiement VPS | **Volontairement pas fait** : ni Docker, ni sauvegardes, ni surveillance. |

## 8. Sauvegarder tes données de test (2 minutes, recommandé)
```bash
pg_dump "postgresql://angel:angel@localhost:5432/angel_os" > angel_os_$(date +%F).sql
```
Restaurer dans une base vide : `psql "<url>" < angel_os_AAAA-MM-JJ.sql`.

## 9. Dépannage rapide
| Symptôme | Cause probable |
|---|---|
| L'API ne démarre pas : « ANGEL_OS_SYSTEM_PRINCIPAL_ID must be set » | tu n'as pas chargé le `.env` (`set -a; . ./.env; set +a`) |
| Le cockpit refuse de démarrer | jeton ou hash absent ou mal recopié (guillemets simples autour de `scrypt$…`) |
| Page blanche / impossible de se connecter en local | oublie de `GUIDEHUB_INSECURE_COOKIES=1` |
| « Port already in use » | un ancien processus tourne : arrête-le (ports 3000 et 3100) |
| Erreur de base de données | PostgreSQL éteint, ou mauvais `DATABASE_URL` |
| Trop d'essais de connexion (429) | attends quelques minutes |

## 10. Pour relancer les vérifications automatiques (si tu modifies le code)
```bash
set -a; . ./.env; set +a
npm test            # tous les tests
npm run typecheck   # types
npm run build       # compilation
```
Le test navigateur complet (optionnel) est décrit dans `docs/guidehub/README.md`.

---
État du code au moment de ce guide : dernier commit local `6ee58cf` (rien de poussé sur GitHub).
