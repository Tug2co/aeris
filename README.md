# Aeris — Planifier · Coordonner · Couvrir

[![CI](https://github.com/Tug2co/aeris/actions/workflows/ci.yml/badge.svg)](https://github.com/Tug2co/aeris/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Node Version](https://img.shields.io/badge/node-%3E%3D22-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)

Outil d'aide à la décision pour **dimensionner et coordonner l'emploi des drones** en opération de gendarmerie (Hackathon Drones, Région de gendarmerie d'Occitanie, 14/10/2026).

## Démarrer

Prérequis : Node 22. `pnpm` est fourni par Corepack (inclus dans Node) :

```bash
corepack enable     # une fois par machine (sinon : « pnpm: commande introuvable »)
pnpm install        # toutes les dépendances sont déjà déclarées : ne pas en ajouter sans prévenir P1
pnpm dev            # API sur :3001, front sur http://localhost:5173
pnpm dev:mock       # front seul, sur un faux backend en mémoire (voir « Mocks du front »)
pnpm typecheck      # avant chaque merge request
pnpm test           # tests de contrat + intégration
pnpm format         # avant chaque commit
```

Le squelette fonctionne déjà de bout en bout : charger la mission de démo → phasage → 3 propositions → lancer l'opération → déclarer un TP indisponible → recalculer → appliquer.

## Hypothèses retenues

| Sujet                  | Décision                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Langage                | TypeScript partout (front, back, solveur)                                                                          |
| Couples TP + drone     | Fixés à la configuration, l'algo ne les recompose pas                                                              |
| Zone limite d'un drone | Polygone configurable (`allowedArea`) **ou** position imposée (`fixedPosition`), sinon l'algo propose              |
| Relief                 | Hauteur /sol uniquement, pas de masques de relief                                                                  |
| Portée                 | Portées max uniquement (TP1 1 km, TP2 2 km), pas de gestion du vol en vue                                          |
| Temporalité            | N phases choisies par l'opérateur ; les zones prioritaires changent selon la phase ; pas de gestion de l'autonomie |
| Temps réel             | Un seul poste fixe ; positions et couverture poussées par WebSocket                                                |
| Zone de travail        | Polygone défini au début, tout le calcul se fait dedans                                                            |
| Hauteurs               | TP1 : 50 m rural / 80 m urbain ; TP2 : 120 m ; 50 m près d'un terrain militaire (zone `hauteur_limitee`)           |

## Architecture

```
            ┌──────────────── apps/web (React + Leaflet) ────────────────┐
            │ features/config   features/scenarios   features/live        │
            │        map/ (fonds IGN · OSM · ortho, couches partagées)    │
            └──────────── REST /api/* ────────────── WebSocket live ──────┘
                                     │
            ┌──────────────── apps/api (Fastify) ─────────────────────────┐
            │ routes/*.ts (auto-chargées)   store (mémoire)   services/   │
            │ pipeline : grille → solveur → séparation → métriques        │
            └──────┬──────────────┬──────────────┬──────────────┬─────────┘
                   │              │              │              │
             packages/geo   packages/solver  packages/deconflict  packages/weather
                   └──────────────┴──── packages/shared (contrats zod) ─┘
                                        packages/data (catalogue, fixtures)
```

Cycle de vie d'une mission (machine à états côté API) :
`config` → `phasage` → `propositions` → `conduite` (événements → recalcul proposé → validation opérateur).

### Le modèle de calcul

1. **Grille** (`geo/buildGrid`) : la zone de travail est découpée en cellules de 100 m, une grille par phase. Chaque cellule porte sa priorité (zones actives dans la phase), ses capacités requises (zoom, thermique, nuit), et ses contraintes (interdite, plafond, urbain).
2. **Placement** (`solver`) : couverture maximale pondérée (MCLP). v0 = glouton ; v1 = programme linéaire en nombres entiers avec HiGHS (`ilp.ts`, modèle décrit en commentaire). Contraintes : disponibilité, météo, arrêté (`maxDrones`), zone limite, position imposée, capacités. Une pénalité de déplacement par rapport à la solution précédente assure la **stabilité** entre phases et lors des recalculs.
3. **Séparation** (`deconflict`) : cascade du brief horizontal → vertical → temporel → renoncement. v0 = tranches d'altitude de 20 m.
4. **Mesure** (`geo/computeMetrics`) : couverture totale, prioritaire (par un drone capable), pondérée, chevauchement, surfaces.
5. **Plusieurs propositions** : une par stratégie (`couverture_globale`, `priorite`, `economie_moyens`), calculées en parallèle.

## Contrats et tests : garantir que tout se branche

Trois niveaux, du plus local au plus global. **Si ta suite de contrat passe, ton module se branchera.**

### 1. Interfaces (`packages/shared/src/engines.ts`)

Chaque moteur implémente un type déclaré dans `shared`, et le déclare explicitement :

| Interface                 | Implémentation                                 | Propriétaire |
| ------------------------- | ---------------------------------------------- | ------------ |
| `GridBuilder`             | `buildGrid` (`packages/geo`)                   | P3           |
| `MetricsEngine`           | `computeMetrics` (`packages/geo`)              | P3           |
| `CoverageGeometryBuilder` | `coverageGeometry` (`packages/geo`) → carte    | P3 → P5      |
| `StabilityEngine`         | `mesurerStabilite` (`packages/geo`) → recalcul | P3 → P6      |
| `Solver`                  | `greedySolve`, `ilpSolve` (`packages/solver`)  | P2           |
| `Deconflicter`            | `deconflict` (`packages/deconflict`)           | P4           |
| `WeatherProvider`         | `fetchWeather` (`packages/weather`)            | P4           |
| `WeatherFilter`           | `excludedByWeather` (`packages/weather`)       | P4           |

Changer une signature casse la compilation **dans ton propre dossier**, pas chez les autres : c'est voulu. Besoin d'un paramètre de plus ? Il est probablement déjà dans le contexte (`SolveContext`, `DeconflictContext`) ; sinon, MR sur `shared` via P1.

Les données échangées avec le front (mission, propositions, événements, `CoverageLayers`…) sont des schémas zod : l'API valide ce qui entre, les tests valident ce qui sort.

### 2. Suites de contrat (`packages/contracts`)

Des tests écrits une fois, que **chaque implémentation** exécute dans son package (`src/contract.test.ts`). Ils tournent sur toutes les missions de test de `packages/data/src/fixtures/index.ts` (démo, aucun moyen, arrêté à 0, position imposée, nuit sans thermique, plafond militaire, urbain, 3 phases, zone minuscule, grande zone interdite).

| Suite                   | Ce qui est garanti                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `solverContract`        | < 5 s ; arrêté respecté ; seulement des couples disponibles et non exclus (et chaque exclusion expliquée) ; position imposée, zone limite, zone de travail, zones interdites ; portée et plafond du niveau ; `infaisable` expliqué |
| `deconflictContract`    | aucun couple perdu sans le dire ; sous le plafond du solveur et les plafonds locaux ; position imposée intacte ; tout conflit résiduel déclaré                                                                                     |
| `gridContract`          | cellules dans la zone ; priorité, capacités, interdit, urbain et plafonds conformes à la config de la phase                                                                                                                        |
| `metricsContract`       | ratios dans [0, 1], surfaces cohérentes, cas « rien / tout / double », monotonie                                                                                                                                                   |
| `coverageContract`      | ce que la carte affiche (couvert, trous, chevauchement) = ce que les métriques mesurent                                                                                                                                            |
| `weatherFilterContract` | exclusions exactes (vent, pluie, nuit, froid), toujours justifiées                                                                                                                                                                 |

Les vérifications utilisent leurs propres calculs géométriques (pas `@aeris/geo`), pour qu'un bug ne se valide pas lui-même. Une règle du contrat te bloque à tort ? Parles-en à P1, on la corrige ensemble ; ne la contourne pas dans ton code.

Tes propres tests métier (qualité de la solution, cas particuliers) vont à côté, dans ton package (`*.test.ts`).

### 3. Intégration (`apps/api/src/api.test.ts`)

Joue le scénario de démo complet contre l'API (création → solve → couverture → édition → conduite → WebSocket → TP indisponible → recalcul → validation → changement de phase), sans réseau, en validant **chaque réponse** avec les schémas zod. C'est la garantie que `main` démarre.

### Ma commande avant chaque MR

```bash
pnpm --filter @aeris/solver test       # P2
pnpm --filter @aeris/geo test          # P3 (+ @aeris/data)
pnpm --filter @aeris/deconflict test   # P4
pnpm --filter @aeris/weather test      # P4
pnpm --filter @aeris/web test          # P5, P6
pnpm typecheck && pnpm test            # tout le monde, avant de pousser
```

### Mocks du front

`pnpm dev:mock` lance le front sur un faux backend en mémoire (`apps/web/src/api/mock.ts`) : P5 et P6 avancent sans attendre l'API ni le solveur. Les réponses viennent de `apps/web/src/api/mocks/snapshot.json`, **capturé sur la vraie API** par `pnpm mocks`. Un test vérifie qu'il respecte toujours les schémas : après une évolution de `shared`, relancer `pnpm mocks` et commiter le fichier.

Nouvelle route ? P1 l'ajoute au client (`api/client.ts`), au mock et au script `gen-mocks.ts` dans la même MR.

## Répartition (6 personnes)

Chaque personne **possède un dossier** : personne d'autre n'y écrit sans la prévenir (voir `.github/CODEOWNERS`).

| #      | Rôle                          | Dossiers possédés                                                                          | Livrables clés                                                                                                                                                      |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Lead archi / intégration      | `packages/shared`, `packages/contracts`, `apps/api`, racine                                | dépôt + CI, contrats, routes, pipeline, simulation « avec N TP1 / M TP2 », export du dispositif, merges, démo                                                       |
| **P2** | Solveur                       | `packages/solver`                                                                          | ILP HiGHS (limite ~3 s, repli glouton), stratégies réellement différentes, **dimensionnement** (« quels moyens me faut-il pour X % ? »), statut infaisable expliqué |
| **P3** | Moteur géo                    | `packages/geo`, `packages/data`                                                            | polygones de couverture / trous / chevauchements en GeoJSON pour la carte, communes concernées, métrique de **stabilité après changement**, performance             |
| **P4** | Séparation & météo            | `packages/deconflict`, `packages/weather`                                                  | cascade complète (secteurs Voronoï, plafonds locaux urbain/militaire, créneaux, renoncement), météo par phase (prévision horaire)                                   |
| **P5** | Front carte & configuration   | `apps/web/src/map`, `apps/web/src/features/config`                                         | dessin des zones (leaflet-geoman), formulaires couples/arrêté/phases, curseurs de simulation, couches couverture/trous                                              |
| **P6** | Front propositions & conduite | `apps/web/src/features/scenarios`, `apps/web/src/features/live`, `apps/web/src/components` | comparaison des propositions, édition des positions, conduite temps réel, ajout de zone prioritaire en direct, panneau de démo                                      |

Points de couplage à anticiper :

- **P3 ↔ P5** : P3 calcule les géométries de couverture (`CoverageLayers`, routes `.../coverage` et `.../live/coverage`), P5 les affiche. La forme est figée ; P3 peut améliorer le calcul (fusion des carrés) sans rien casser chez P5.
- **P2 ↔ P4** : le solveur place, la séparation ajuste ; si la séparation renonce à un couple, elle le dit dans `diagnostics`.
- **P1 ↔ tous** : toute évolution de `packages/shared` passe par P1.

## Règles pour éviter les conflits de merge

1. **Contrats d'abord** : `packages/shared` est la seule interface entre les équipes. Modification = petite MR dédiée, mergée vite par P1, annoncée à tous.
2. **Dépendances** : tout est installé. Besoin d'un paquet ? Le demander à P1, qui l'ajoute en une MR (le `pnpm-lock.yaml` est la première source de conflits).
3. **Pas de fichier central à enrichir** : les routes API sont auto-chargées (`apps/api/src/routes/`, un fichier par sujet), chaque fonctionnalité front a son store (`features/<nom>/store.ts`), `App.tsx` ne fait qu'assembler.
4. **Formatage** : `pnpm format` avant chaque commit (Prettier commité, même config pour tous).
5. **Branches courtes** : `p2/ilp`, `p5/geoman`… Rebase sur `main` et merge toutes les 1 à 2 h. Une MR = un sujet.
6. **Travailler contre des mocks** : la mission de démo (`packages/data/src/fixtures`) permet à chacun de tester seul.
7. **CI** : typecheck + format + tests (contrats, intégration, mocks) sur chaque MR ; `main` doit toujours démarrer.
8. **Protection de `main`** (P1, une fois, dans GitHub → Settings → Branches) : interdire le push direct, exiger la CI verte (`check`) et la revue du propriétaire (CODEOWNERS) avant merge. Sans ça, la CI informe mais ne bloque rien.
9. **CODEOWNERS** : remplacer `@p1` … `@p6` par les identifiants GitHub réels.

## Consignes pour les agents IA (Claude, Copilot, Cursor…)

Tout agent qui code sur ce dépôt **lit cette section en entier avant d'écrire une ligne** et la respecte sans exception. P1 relit et merge toutes les PR : un agent ne merge jamais lui-même.

### Avant de commencer

1. Savoir pour quelle personne (P2 … P6) l'agent travaille, donc **quels dossiers il possède** (tableau « Répartition »). Ne pas deviner : demander si ce n'est pas précisé.
2. Lire `packages/shared` (contrats), la section « Contrats et tests » et le code existant du dossier.
3. Partir d'un `main` à jour : `git switch main && git pull --rebase`.

### Périmètre : ce qu'un agent peut modifier

- **Oui** : les fichiers des dossiers possédés par sa personne, et les tests de ces dossiers.
- **Non, jamais** : `packages/shared`, `packages/contracts`, `apps/api`, `pnpm-lock.yaml`, les `package.json`, `.github/`, la configuration racine, les dossiers des autres. Si un changement y est nécessaire (nouveau champ, nouvelle route, nouvelle dépendance), **s'arrêter** et le décrire dans la PR (section « Besoins hors périmètre ») ; P1 s'en charge dans une PR dédiée.
- Ne jamais contourner un contrat : pas de `as any`, `@ts-ignore`, `@ts-expect-error`, `it.skip`, `.only`, seuil assoupli ni test de contrat modifié pour « faire passer ». Un contrat qui semble faux se signale dans la PR.

### Branches

- Une branche par sujet, créée depuis `main` : `p<N>/<sujet-court>` en kebab-case, ex. `p2/ilp-highs`, `p5/dessin-zones`.
- **Jamais de commit ni de push sur `main`.** Jamais de `git push --force` ; après un rebase de sa propre branche uniquement : `git push --force-with-lease`.
- Durée de vie courte (1 à 2 h) : mieux vaut deux petites PR qu'une grosse.
- Se remettre à jour par rebase, pas par merge : `git fetch && git rebase origin/main`. Conflit sur un fichier hors périmètre ? Ne pas le résoudre au hasard : garder la version de `main` et prévenir.

### Commits

- Petits et cohérents : un commit = un changement compréhensible seul, qui compile.
- Message au format Conventional Commits, en français, scope = package : `feat(solver): modèle ILP avec repli glouton`, `fix(geo): plafond local ignoré en bordure`, `test(deconflict): cas des créneaux`. Types : `feat`, `fix`, `refactor`, `test`, `docs`, `perf`, `chore`.
- Ajouter la ligne `Co-Authored-By:` de l'agent (déclaration d'usage de l'IA exigée par le hackathon).
- Ne commiter ni secret, ni `.env`, ni fichier généré (`dist/`, `node_modules/`), ni fichier sans rapport avec le sujet. Vérifier avec `git status` et `git diff --staged` avant chaque commit.

### Avant d'ouvrir la PR (tout doit passer)

```bash
git fetch && git rebase origin/main
pnpm format
pnpm typecheck
pnpm test
```

Ne jamais ouvrir une PR rouge en prétendant qu'elle est prête : si quelque chose échoue, ouvrir la PR en **brouillon (draft)** et écrire ce qui échoue et pourquoi.

### Pull requests

- Cible `main`, relecteur **P1**. Une PR = un sujet, idéalement < 400 lignes modifiées (hors snapshot de mocks).
- Titre au format d'un commit : `feat(solver): ILP HiGHS avec limite de 3 s`.
- Description selon `.github/pull_request_template.md` : quoi, pourquoi, comment tester, impact sur les contrats, besoins hors périmètre, usage de l'IA.
- Après la relecture : corriger par **nouveaux commits** (pas de réécriture de l'historique pendant la revue), répondre à chaque commentaire, ne pas fermer un fil soi-même.
- Ne pas merger, ne pas approuver sa propre PR, ne pas modifier la protection de branche.

### Code

- TypeScript strict, style du code voisin (Prettier fait foi), noms et commentaires **en français**, commentaires utiles seulement (le pourquoi, pas le quoi).
- Utiliser les types et schémas de `@aeris/shared` ; ne jamais redéfinir localement un type qui y existe.
- Moteurs (`packages/*`) : fonctions pures, sans état global, sans réseau (sauf `fetchWeather`), sans `console.log` laissé.
- Front : chaque fonctionnalité garde son store dans `features/<nom>/store.ts` ; appels réseau uniquement via `api/client.ts` ; tester avec `pnpm dev:mock`.
- Pas de nouvelle dépendance (voir règle 2 des conflits de merge).
- Chaque comportement nouveau a un test dans son package ; les tests n'appellent pas le réseau.
- Garder les marqueurs `TODO(Px)` des autres ; retirer les siens quand c'est fait.
- Rester dans le sujet : pas de refactoring opportuniste, pas de reformatage de fichiers non touchés.

## Planning (8 h)

| Heure             | Jalon                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| 10 h 30 – 11 h    | Chacun clone, lance `pnpm dev`, lit `packages/shared` et le README ; accords P3/P5 et P2/P4    |
| 11 h – 14 h       | v1 de chaque module, merges réguliers                                                          |
| **14 h**          | **Intégration n°1** : tout est sur `main`, démo interne                                        |
| 14 h – 16 h 30    | v2 : ILP, cascade de séparation, dessin des zones, conduite complète, dimensionnement          |
| **16 h 30**       | **Gel des fonctionnalités**                                                                    |
| 16 h 30 – 17 h 45 | Robustesse, scénario de démo, documentation du code, déclaration d'usage de l'IA               |
| 17 h 45 – 18 h 30 | Répétition avec changements imposés (TP indisponible, coup de vent, nouvelle zone prioritaire) |

## Données à valider

- `packages/data/src/drones.json` : autonomie, vent max, zoom, thermique et nuit sont **indicatifs** (Mavic 3 Enterprise = version 3E sans thermique ; la 3T en a une).
- `packages/data/src/pilot-rules.json` : capacités TP1/TP2 du mémo « scénarios drone ».
- `PRIORITY_WEIGHTS` et `MILITARY_MAX_HEIGHT_M` dans `packages/shared/src/rules.ts`.
- Mission de démo (forêt de Bouconne) : géométries fictives, à remplacer par les données de l'organisateur dès qu'elles arrivent.

## Usage de l'IA (déclaration hackathon)

Conformément au règlement du Hackathon Drones de la Région de gendarmerie d'Occitanie, l'usage des technologies d'intelligence artificielle est déclaré comme suit :

- **Architecture, contrats et documentation initiale** : cadrage du projet, schémas Zod et contrats de tests générés avec Claude (Anthropic), relus et validés par l'équipe.
- **Développement assisté par agents de code** : implémentation et tests automatisés des moteurs (`solver`, `deconflict`, `weather`, `geo`), de l'API Fastify et de l'interface React/Leaflet développés en collaboration avec des agents d'ingénierie logicielle (Google DeepMind Antigravity / Gemini).
- **Contrôle et validation humaine** : 100 % de la logique métier, des arbitrages opérationnels et réglementaires (arrêtés préfectoraux, tranches d'altitude, deconfliction) et de la validation de bout en bout ont été vérifiés, testés (suite de plus de 200 tests automatisés) et pilotés par les membres de l'équipe.

## Licence

Ce projet est distribué sous [licence MIT](LICENSE).  
Copyright (c) 2026 Équipe Aeris.
