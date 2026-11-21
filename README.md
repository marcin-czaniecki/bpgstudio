# BPG Studio

Monorepo BPG Studio: Electron + electron-vite + React + TypeScript.
Na tym etapie aplikacja wyświetla ekran startowy i sprawdza działanie typowanego IPC.
**Nie zawiera jeszcze klienta PostgreSQL, SQL Editora ani ERD.**

## Wymagania

- Windows 11 / PowerShell 7 albo obsługiwany system developerski
- Node.js >= 22.12
- pnpm 10 (wersję zaleca się przypiąć wraz z pierwszym lockfile)
- Git

## Pierwsze uruchomienie

```powershell
cd bpgstudio
npm install -g pnpm@10
pnpm install
pnpm dev
```

Po uruchomieniu powinno pojawić się okno BPG Studio z numerem wersji pobranym
przez bezpieczne IPC. Lokalny PostgreSQL nie jest na razie wymagany.

## Walidacja

```powershell
pnpm typecheck
pnpm test
pnpm format
pnpm lint
pnpm build
```

Dla pnpm 10 jawnie dopuszczone skrypty instalacyjne `electron` i `esbuild`
znajdziesz w `pnpm-workspace.yaml`. Jeśli instalator ostrzega o innych
zablokowanych skryptach, sprawdź je przed wywołaniem `pnpm approve-builds`.

`pnpm format` może wprowadzić zmiany formatowania. Uruchom je przed pierwszym commitem.
Przy pierwszym `pnpm install` powstaje `pnpm-lock.yaml`. **Dodaj go do Git**.
Dopiero potem uruchamiaj CI, które używa `--frozen-lockfile`.

Wersje bibliotek są określone zakresami, aby dało się wykonać pierwszą instalację.
Po instalacji pinujemy wersje i lockfile; późniejsze aktualizacje wykonujemy świadomie.

## Repozytorium Git

```powershell
git init
git add .
git commit -m "chore: bootstrap BPG Studio monorepo"
```

Przed opublikowaniem repozytorium zdecyduj o licencji i nazwie marki.
Repozytorium nie dołącza jeszcze licencji do kodu aplikacji, ponieważ decyzja prawna
co do modelu Open Core pozostaje po Twojej stronie.

## Architektura

- `apps/desktop`: Electron Main, sandboxowany Preload, React Renderer.
- `packages/contracts`: publiczny kontrakt IPC oraz walidacja odpowiedzi.
- `packages/database-core`: minimalne interfejsy do późniejszej obsługi silników.
- `packages/database-postgres`: miejsce pierwszego adaptera, bez implementacji.
- `packages/schema-core`: miejsce modelu schematu, bez narzuconych abstrakcji Multi-DB.
- `AGENTS.md`: konwencje dla kontrybutorów i narzędzi AI.

## Bezpieczeństwo

- Renderer nie ma `nodeIntegration` i działa z `sandbox: true`.
- `contextIsolation: true`.
- Preload ujawnia pojedyncze, dedykowane API, nie całe `ipcRenderer`.
- IPC waliduje odpowiedź w kontrakcie.
- Nawigacja na obce strony i nowe okna są blokowane.
- Nie umieszczaj haseł baz danych w stanie renderera ani w logach.

## Packaging

```powershell
pnpm build
pnpm dist:win
```

Przy podpisywaniu i publicznej dystrybucji instalatorów trzeba skonfigurować
prawidłowy identyfikator aplikacji, certyfikat i proces aktualizacji. Szkielet
ma placeholder `dev.bpgstudio.app` i nie jest przygotowany do publikacji w sklepie.
