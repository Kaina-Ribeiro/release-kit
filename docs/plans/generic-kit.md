# release-kit genérico: plano de implementação

> **Para agentes:** use superpowers:executing-plans (ou superpowers:subagent-driven-development) tarefa a tarefa.
> Passos em checkbox (`- [ ]`). Ao terminar uma tarefa, atualize a linha **Status** dela e a seção **Notas**.

**Goal:** implementar `docs/specs/generic-kit.md`: deploy opcional e por adaptador (`cubeship` ou `command`), botão de deploy em arquivo próprio, `CHECKS_COMMAND`, `TICKET_PATTERN=none` e instalação com um comando, sem quebrar os 3 repos em `@v1`.

**Architecture:** o `release.mjs` continua dono das regras e passa a carregar um adaptador de `adapters/<nome>.mjs` só quando um comando faz deploy ou confere prod. O código Cubeship sai do `release.mjs` para `adapters/cubeship.mjs` sem mudar comportamento. O projeto recebe dois chamadores: `release.yml` (sempre) e `deploy.yml` (só com deploy), os dois chamando o mesmo workflow reutilizável do kit.

**Tech Stack:** Node 18+ ESM sem dependências, bash, git, GitHub Actions.

**Spec:** `docs/specs/generic-kit.md` (aprovado em 2026-11-11). Leia o spec e este plano antes de começar.

## Como executar (regras do dono)

- **Uma sessão nova por fase**, na ordem 1 → 2 → 3. A sessão faz só a sua fase, atualiza Status e Notas e relata em até 5 linhas.
- **Um branch só:** `feat/generic-kit`, criado da `master` atualizada. O primeiro commit inclui o spec e este plano. Um PR no fim (Fase 3).
- **Sem o "sim" do dono no chat:** nada de push, PR, merge, criação ou movimento de tag, nem mudança de configuração.
- Commits em Conventional Commits, inglês, minúsculo, no imperativo: `feat: deploy through an adapter`.
- Status: `⏳ pending` · `🔄 in progress` · `✅ done (<commit>)` · `❌ blocked: <motivo>`.

## Global Constraints

- `release.mjs` e os adaptadores: Node 18+, zero dependências, ESM. Toda ação respeita `--dry-run`: imprime `[dry-run] would …` e não muda nada.
- Um erro esperado é sempre `fail(msg)` (classe `Failure`, sem stack). As mensagens são em inglês; as que este plano fixa são copiadas literalmente.
- **As seções 0 a 16 de `test/fixtures.sh` não são editadas.** Só o `trap` de limpeza pode ganhar os processos novos. Se uma delas quebrar, o erro está no código, não no teste.
- `status`, `deploy-check` e `conventions` funcionam com o `release.mjs` sozinho, sem a pasta `adapters/`.
- Os chamadores (`workflows/*.yml`) e o texto do `install.sh` fora do bloco de deploy não citam o Cubeship.
- Os nomes dos checks obrigatórios não mudam: `pr-checks / checks`, `pr-checks / conventions`.
- Teste de cada tarefa: `bash test/fixtures.sh "" "$(mktemp -d)"` sai com 0 e termina em `✓ all expectations met`. No Windows, pelo Git Bash.
- As seções novas entram depois da seção 16 e antes do bloco final que conta os `misses`. Cada uma começa com `fresh <nome>`, salvo indicação.
- Linhas citadas como `~N` são do `release.mjs` de 2026-11-11. O nome da função é a referência.

## Review Focus

1. **Um `CHECKS_COMMAND` que varre a pasta toda** (`eslint .`, `ruff check .`) não pode enxergar os arquivos do kit. → Task 2.2: o kit é movido para fora do workspace antes de rodar; o teste confere.
2. **Script de deploy que trava.** O job não pode ficar preso até o limite de 6 h do GitHub. → Task 1.2: limite de 45 min por alvo, com teste.
3. **`TICKET_PATTERN=none` num projeto que ainda usa tickets** (`feat/ABC-12-login`, `feat(ABC-12): add login`): tem de passar. → Task 2.1.
4. **`--force` num repo com deploy no formato antigo** não pode tirar o botão. → Task 2.3.
5. **Download que falha no meio da instalação** não pode deixar o projeto com metade dos arquivos. → Task 2.3.

---

## Fase 1: deploy por adaptador

### Task 1.1: a costura do adaptador + Cubeship movido

**Status:** ⏳ pending

**Files:**
- Create: `adapters/cubeship.mjs`
- Modify: `release.mjs` (seção "Cubeship (deploys)" ~392–572, `checkProdRuns` ~678, `cmdDeploy` ~891)
- Modify: `test/fixtures.sh` (seções 17 e 18)

**Interfaces:** Produces, usadas pelas Tasks 1.2 e 1.3:

```js
// adapters/<nome>.mjs
export default function create(ctx) { return adapter; }
// ctx     = { dryRun, log, act, warn, fail, Failure, commitOf, repoRoot }   repoRoot(): string
// adapter = {
//   name: string,                 // 'cubeship'
//   missing: string,              // o que falta definir, para a mensagem: 'DEPLOY_URL and DEPLOY_TOKEN'
//   configured(): boolean,
//   async deploy(target, tag, stage): void,   // termina com o alvo rodando a tag e de pé; falha com Failure
//   async runs(target, tag, stage): { runs: true | false | null, current: string },
// }

// release.mjs
const ADAPTERS = ['cubeship'];                 // a Task 1.2 acrescenta 'command'
function adapterName(): string                 // regras do spec, "Qual adaptador é usado"
async function deployAdapter(): adapter        // import dinâmico relativo a import.meta.url, com cache
```

Mensagens fixas:
- `DEPLOY_ADAPTER` inválido: `DEPLOY_ADAPTER must be one of: cubeship, command; got "foo"` (a lista vem de `ADAPTERS`).
- Arquivo do adaptador ausente: `the <name> deploy adapter is not beside release.mjs (adapters/<name>.mjs); deploys need a full copy of the kit`.
- Não configurado, fora de `--dry-run`, com `DEPLOY_ADAPTER` vazio: `no deploy adapter is configured: set DEPLOY_COMMAND (your own script), or DEPLOY_URL and DEPLOY_TOKEN (Cubeship)`.
- Não configurado, com `DEPLOY_ADAPTER` definido: `the <name> deploy adapter needs <adapter.missing>`.
- Não configurado em `--dry-run`: por alvo, `act('deploy <tag> to <target>')`; no `final`, `(no deploy credentials: skipping the check that prod runs <rc>)`.

- [ ] **Step 1: seção 17, "só tags" (guarda: já passa hoje e tem de continuar passando).**

```bash
echo; echo "=== 17. tags only: no deploy variable, nothing deploys, final does not look at prod"
fresh tagsonly
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): first"; tag v0.1.0-rc origin/release/v0.1
expect_out ok "no test apps (DEPLOY_TEST_APPS is empty); nothing to deploy" deploy --stage test --branch release/v0.1
expect_out ok "no prod apps (DEPLOY_PROD_APPS is empty); nothing to deploy" deploy --stage prod --branch release/v0.1
merge_into_default release/v0.1
out=$(node "$kit/release.mjs" final --head release/v0.1 --dry-run 2>&1); printf '%s\n' "$out"
check "final tags the rc" grep -qF "→ v0.1.0 (same code as v0.1.0-rc)" <<<"$out"
check "final does not look at prod" not grep -qE "prod runs|prod does not run|deploy credentials" <<<"$out"
```

- [ ] **Step 2: seção 18, Cubeship pelos nomes novos (falha antes da mudança).** Mock próprio na porta 47128 sobre `$scratch/cubenames/work`; acrescente o pid ao `trap`.

```bash
echo; echo "=== 18. the cubeship adapter reads DEPLOY_URL and DEPLOY_TOKEN; adapter selection"
fresh cubenames
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): first"; tag v0.1.0-rc origin/release/v0.1
# mock em 47128; RELEASE_DEPLOY_POLL_MS=50 RELEASE_HEALTH_POLL_MS=50 RELEASE_HEALTH_STABLE_S=1 RELEASE_HEALTH_WAIT_S=2
export DEPLOY_TEST_APPS=demo/test/api
DEPLOY_URL=http://127.0.0.1:47128 DEPLOY_TOKEN=test-key expect_out ok "✓ demo/test/api runs v0.1.0-rc" deploy --stage test --branch release/v0.1
DEPLOY_ADAPTER=cubeship DEPLOY_URL=http://127.0.0.1:47128 DEPLOY_TOKEN=test-key expect ok deploy --stage test --branch release/v0.1
DEPLOY_ADAPTER=foo expect_out fail 'DEPLOY_ADAPTER must be one of: cubeship' deploy --stage test --branch release/v0.1
expect_out fail "no deploy adapter is configured: set DEPLOY_COMMAND" deploy --stage test --branch release/v0.1
DEPLOY_ADAPTER=cubeship expect_out fail "the cubeship deploy adapter needs DEPLOY_URL and DEPLOY_TOKEN" deploy --stage test --branch release/v0.1
expect_out ok "would deploy v0.1.0-rc to demo/test/api" deploy --stage test --branch release/v0.1 --dry-run
# release.mjs sozinho (sem adapters/): os comandos que não deployam funcionam, o deploy diz o que falta
cp "$kit/release.mjs" "$scratch/alone.mjs"
check "status works from release.mjs alone" node "$scratch/alone.mjs" status
check "deploy-check works from release.mjs alone" node "$scratch/alone.mjs" deploy-check v0.1.0-rc
out=$(DEPLOY_URL=http://127.0.0.1:47128 DEPLOY_TOKEN=test-key node "$scratch/alone.mjs" deploy --stage test --branch release/v0.1 2>&1)
check "a deploy from release.mjs alone says the adapter is missing" grep -qF "is not beside release.mjs" <<<"$out"
unset DEPLOY_TEST_APPS   # e mate o mock
```

- [ ] **Step 3:** rodar os testes → a seção 17 passa; a 18 dá `✗ MISS`.
- [ ] **Step 4:** criar `adapters/cubeship.mjs`. Mover para lá, sem mudar a lógica: `BUILDING_SOURCES`, `DEPLOY_WAIT_MS`, `cubeship()`, `appPath`, `getBuildingApp`, `lastDeployment`, `runs`, `sleep`, `DEPLOY_POLL_MS`, `MAX_POLL_ERRORS`, `waitForDeploy`, `envSeconds`, `HEALTH_POLL_MS`, `waitForHealthy` e o corpo do laço de `deployTag` (vira `deploy(target, tag)`, sem a linha `dryRun && !hasCubeship()`, que agora é do kit). URL = `DEPLOY_URL || CUBESHIP_URL`; token = `DEPLOY_TOKEN || CUBESHIP_TOKEN`. `runs()` devolve `{ runs: <o runs de hoje>, current: app.ref }`. As mensagens que citam `CUBESHIP_URL`/`CUBESHIP_TOKEN` passam a citar `DEPLOY_URL`/`DEPLOY_TOKEN`.
- [ ] **Step 5:** em `release.mjs`: `ADAPTERS`, `adapterName`, `deployAdapter` e o `ctx`. `deployTag(tag, targets, stage)` vira o laço genérico: carrega o adaptador depois do `checkDeploy`; não configurado → as mensagens acima; senão `await adapter.deploy(target, tag, stage)` por alvo. `checkProdRuns` usa `adapter.runs`: `false` entra em `behind` como `<target> (<current>)`; o texto `prod does not run …` e `✓ prod runs …` não muda. `stageApps` fica no `release.mjs`.
- [ ] **Step 6:** rodar os testes → `✓ all expectations met`, com as seções 8, 8b e 9 intactas.
- [ ] **Step 7:** commit: `refactor: move the cubeship deploy behind an adapter`.

### Task 1.2: adaptador `command`

**Status:** ⏳ pending

**Files:**
- Create: `adapters/command.mjs`, `test/deploy-command.sh`
- Modify: `release.mjs` (`ADAPTERS`, `adapterName`, `checkProdRuns`), `test/fixtures.sh` (seção 19)

**Interfaces:**
- Consumes: `create(ctx)` e o formato de `adapter` da Task 1.1.
- Produces: `ADAPTERS = ['cubeship', 'command']`; com `DEPLOY_ADAPTER` vazio e `DEPLOY_COMMAND` definido, `adapterName()` devolve `'command'`.

Contrato do adaptador (o que o spec fixa em "Adaptador `command`"):
- Execução: `bash -c '<DEPLOY_COMMAND> "$@"' deploy-command <verbo> <stage> <alvo> [<tag>]`, com `cwd = ctx.repoRoot()` e, no ambiente, `RELEASE_TAG`, `RELEASE_SHA` (commit da tag), `RELEASE_STAGE`, `RELEASE_TARGET` além do ambiente do processo.
- `configured()` = `DEPLOY_COMMAND` não vazio; `missing` = `'DEPLOY_COMMAND'`.
- `deploy`: saída do comando vai direto para o log. Limite: 45 min (`RELEASE_DEPLOY_TIMEOUT_MS` troca o valor, só para teste). Mensagens:
  - `--dry-run`: `act('run: <DEPLOY_COMMAND> deploy <stage> <target> <tag>')`, sem executar.
  - sucesso: `✓ <target> runs <tag>`.
  - saída ≠ 0: `<target>: the deploy command exited with <code> (<DEPLOY_COMMAND> deploy <stage> <target> <tag>)`.
  - tempo esgotado: `<target>: the deploy command is still running after <N> min; stopped waiting`.
- `runs`: executa `current <stage> <alvo>` (também em `--dry-run`), captura a saída padrão. `current` = primeira linha não vazia, sem espaços nas pontas.
  - saída ≠ 0: `<target>: the deploy command exited with <code> (<DEPLOY_COMMAND> current <stage> <target>)`.
  - vazio → `{ runs: null, current: '' }`.
  - igual ao nome da tag, ou só hexadecimal com 7 a 40 caracteres e prefixo do commit da tag (sem diferenciar maiúsculas) → `runs: true`. Senão `false`.
- No `checkProdRuns`, para cada alvo com `runs: null`: `warn('<target>: the deploy command does not say what it runs; not checking that prod runs <rc>')` e a mesma frase no `summary`. O `final` segue. A linha `✓ prod runs <rc>: …` lista só os alvos conferidos e some se nenhum foi conferido.

- [ ] **Step 1:** criar `test/deploy-command.sh`. Estado em `$DEPLOY_STATE` (uma pasta).
  - `deploy <stage> <target> <tag>`: acrescenta a linha `<RELEASE_STAGE> <RELEASE_TARGET> <RELEASE_TAG> <RELEASE_SHA>` em `$DEPLOY_STATE/log`; alvo `bad` sai com 1 antes de gravar; alvo `slow` faz `sleep 5`; senão grava a tag em `$DEPLOY_STATE/<stage>-<target>`.
  - `current <stage> <target>`: alvo `mute` não imprime nada; `boom` sai com 3; `sha` imprime os 12 primeiros caracteres do commit da tag gravada; senão imprime o conteúdo do arquivo, ou `none` se não existe.
- [ ] **Step 2: seção 19 (falha antes da implementação).**

```bash
echo; echo "=== 19. the command adapter: the project's own script deploys and says what runs"
fresh cmdadapter
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): first"; tag v0.1.0-rc origin/release/v0.1
export DEPLOY_COMMAND="bash $kit/test/deploy-command.sh" DEPLOY_STATE="$scratch/cmd-state"; mkdir "$DEPLOY_STATE"
rc_sha=$(git rev-parse 'v0.1.0-rc^{commit}')
DEPLOY_TEST_APPS="web api" expect_out ok "✓ api runs v0.1.0-rc" deploy --stage test --branch release/v0.1
check "both targets, in order, with tag and commit" \
  [ "$(tr '\n' ';' < "$DEPLOY_STATE/log")" = "test web v0.1.0-rc $rc_sha;test api v0.1.0-rc $rc_sha;" ]
DEPLOY_TEST_APPS="bad api2" expect_out fail "bad: the deploy command exited with 1" deploy --stage test v0.1.0-rc
check "the target after a failure is not deployed" [ ! -e "$DEPLOY_STATE/test-api2" ]
DEPLOY_TEST_APPS=web2 expect_out ok "would run: bash $kit/test/deploy-command.sh deploy test web2 v0.1.0-rc" deploy --stage test v0.1.0-rc --dry-run
check "a dry run deploys nothing" [ ! -e "$DEPLOY_STATE/test-web2" ]
RELEASE_DEPLOY_TIMEOUT_MS=300 DEPLOY_TEST_APPS=slow expect_out fail "slow: the deploy command is still running after" deploy --stage test v0.1.0-rc
DEPLOY_ADAPTER=cubeship DEPLOY_TEST_APPS=web expect_out fail "the cubeship deploy adapter needs" deploy --stage test v0.1.0-rc
merge_into_default release/v0.1
DEPLOY_PROD_APPS=web expect_out fail "prod does not run v0.1.0-rc: web (none)" final --head release/v0.1 --dry-run
DEPLOY_PROD_APPS="web sha" expect ok deploy --stage prod v0.1.0-rc
DEPLOY_PROD_APPS="web sha" expect_out ok "✓ prod runs v0.1.0-rc: web, sha" final --head release/v0.1 --dry-run
out=$(DEPLOY_PROD_APPS=mute node "$kit/release.mjs" final --head release/v0.1 --dry-run 2>&1); printf '%s\n' "$out"
check "an empty answer warns" grep -qF "mute: the deploy command does not say what it runs" <<<"$out"
check "and the final still tags" grep -qF "→ v0.1.0 (same code as v0.1.0-rc)" <<<"$out"
DEPLOY_PROD_APPS=boom expect_out fail "boom: the deploy command exited with 3" final --head release/v0.1 --dry-run
unset DEPLOY_COMMAND DEPLOY_STATE
```

- [ ] **Step 3:** rodar → a seção 19 dá `✗ MISS`.
- [ ] **Step 4:** criar `adapters/command.mjs` com `execFileSync` (`timeout`, `stdio`) e acrescentar `'command'` e a regra 2 em `release.mjs`; tratar `runs: null` no `checkProdRuns`.
- [ ] **Step 5:** rodar → `✓ all expectations met`.
- [ ] **Step 6:** commit: `feat: deploy through the project's own command`.

### Task 1.3: workflows e chamadores

**Status:** ⏳ pending

**Files:**
- Modify: `.github/workflows/release.yml`, `workflows/release.yml`
- Create: `workflows/deploy.yml`
- Modify: `release.mjs` (mensagem de `checkProdRuns` ~690), `test/fixtures.sh` (seção 20)

**Interfaces:**
- Produces, para a Task 2.3: `workflows/deploy.yml` existe e termina a linha `uses:` em `@v1`, como os outros chamadores.

- [ ] **Step 1: seção 20 (sem `fresh`; lê os arquivos do kit).**

```bash
echo; echo "=== 20. callers: no deploy button in Release, a Deploy workflow of its own"
rel="$kit/workflows/release.yml"; dep="$kit/workflows/deploy.yml"; kitrel="$kit/.github/workflows/release.yml"
check "the release caller offers only the cuts" grep -qF "options: [cut-release, cut-hotfix]" "$rel"
check "the release caller has no stage or tag input" not grep -qE "inputs\.(stage|tag)" "$rel"
check "the deploy caller runs the kit's deploy" grep -qE "^      command: deploy$" "$dep"
check "the deploy caller is a manual workflow only" not grep -qE "^  (push|pull_request):" "$dep"
check "no caller names Cubeship" not grep -rqi cubeship "$kit/workflows"
for f in "$rel" "$dep"; do
  for key in $(sed -n '/^    with:/,/^    secrets:/p' "$f" | grep -oE '^      [a-z_]+' | tr -d ' '); do
    check "$(basename "$f") passes $key, which the kit declares" grep -qE "^      $key:$" "$kitrel"
  done
  for key in $(sed -n '/^    secrets:/,$p' "$f" | grep -oE '^      [a-z_]+' | tr -d ' '); do
    check "$(basename "$f") passes the secret $key, which the kit declares" grep -qE "^      $key:$" "$kitrel"
  done
done
for name in DEPLOY_ADAPTER DEPLOY_COMMAND DEPLOY_URL DEPLOY_TOKEN CUBESHIP_URL CUBESHIP_TOKEN; do
  check "the kit's workflow sets $name" grep -qE "^  $name: " "$kitrel"
done
```

- [ ] **Step 2:** rodar → a seção 20 dá `✗ MISS`.
- [ ] **Step 3:** `.github/workflows/release.yml`: inputs `deploy_adapter`, `deploy_command`, `deploy_url` (string, default `''`), secret `deploy_token` (não obrigatório), e as 4 linhas no `env:`. `cubeship_url`, `cubeship_token`, `command`, `stage`, `tag` e todos os jobs ficam como estão. Comentário do topo: deploy por adaptador.
- [ ] **Step 4:** `workflows/release.yml`: tirar `deploy` das `options` e os inputs `stage` e `tag`. `with:` passa `command`, `version`, `dry_run`, `deploy_adapter`, `deploy_command`, `deploy_url`, `deploy_test_apps`, `deploy_prod_apps`, `health_stable_s`, `health_wait_s` (de `vars.*` com os mesmos nomes em maiúsculas; os dois últimos de `vars.RELEASE_HEALTH_*`). `secrets:` passa `release_token` e `deploy_token: ${{ secrets.DEPLOY_TOKEN }}`.
- [ ] **Step 5:** criar `workflows/deploy.yml`: `name: Deploy`; `on: workflow_dispatch` com `stage` (choice `test`/`prod`, default `test`), `tag` (string, a descrição de hoje) e `dry_run`; `permissions: contents: read`; job `deploy` com `uses: Kaina-Ribeiro/release-kit/.github/workflows/release.yml@v1`, `command: deploy`, `stage`, `tag`, `dry_run`, as mesmas variáveis de deploy do passo 4 e o secret `deploy_token`.
- [ ] **Step 6:** mensagem do `checkProdRuns`: `Fix: deploy <rc> to prod (Actions → Deploy, stage prod; on an older install: Actions → Release → deploy), then re-run this job.`
- [ ] **Step 7:** rodar → `✓ all expectations met`.
- [ ] **Step 8:** commit: `feat: give deploys their own caller workflow`.

---

## Fase 2: genérico fora do deploy

### Task 2.1: ticket opcional

**Status:** ⏳ pending

**Files:** Modify `release.mjs` (`cmdConventions` ~750), `test/fixtures.sh` (seção 21)

- [ ] **Step 1: seção 21 (sem `fresh`; `cd "$scratch/work"`).**

```bash
echo; echo "=== 21. TICKET_PATTERN=none: branches and titles without a ticket"
cd "$scratch/work" || die "cannot enter $scratch/work"
TICKET_PATTERN=none expect ok conventions --head feat/login --base release/v0.4 --title "feat: add login" --no-fetch
TICKET_PATTERN=none expect ok conventions --head feat/login --base release/v0.4 --title "feat(auth): add login" --no-fetch
TICKET_PATTERN=NONE expect ok conventions --head fix/two-words --base release/v0.4 --title "fix!: drop it" --no-fetch
TICKET_PATTERN=none expect ok conventions --head feat/ABC-12-login --base release/v0.4 --title "feat(ABC-12): add login" --no-fetch
TICKET_PATTERN=none expect_out fail 'must start lowercase' conventions --head feat/login --base release/v0.4 --title "feat: Add login" --no-fetch
TICKET_PATTERN=none expect_out fail 'must be <type>/short-name, e.g. feat/login' conventions --head login --base release/v0.4 --title "feat: add login" --no-fetch
TICKET_PATTERN=none expect_out fail 'must be type: summary, e.g. feat: add login' conventions --head feat/login --base release/v0.4 --title "add login" --no-fetch
expect_out fail 'must be <type>/<TICKET>-short-name' conventions --head feat/login --base release/v0.4 --title "feat: add login" --no-fetch
```

  (`release/v0.4` não precisa existir: para PR de feature o `conventions` só olha o nome.)
- [ ] **Step 2:** rodar → a seção 21 dá `✗ MISS`.
- [ ] **Step 3:** em `cmdConventions`, modo sem ticket quando `TICKET_PATTERN`, sem espaços e em minúsculas, é `none`. Branch: `^(<types>)/[A-Za-z0-9]+(-[A-Za-z0-9]+)*$`. Título: `^(<types>)(\([^)]+\))?!?: (.+)$`. A regra da minúscula vale; a regra "ticket do título = ticket da branch" não. Mensagens como no teste.
- [ ] **Step 4:** rodar → `✓ all expectations met`.
- [ ] **Step 5:** commit: `feat: let TICKET_PATTERN=none drop the ticket from branches and titles`.

### Task 2.2: `checks.sh` e `CHECKS_COMMAND`

**Status:** ⏳ pending

**Files:**
- Create: `checks.sh`
- Modify: `.github/workflows/pr-checks.yml`, `workflows/pr-checks.yml`, `test/fixtures.sh` (seção 22)

**Interfaces:** Produces: `bash checks.sh`, rodado da raiz do projeto, lendo `CHECKS_COMMAND`, `CHECKS_DIRS`, `CHECKS_SCRIPTS`, `CHECKS_DRY_RUN`.

- [ ] **Step 1: seção 22 (sem `fresh`; pastas próprias em `$scratch/checks-*`).**

```bash
echo; echo "=== 22. checks.sh: the project's own command, or the Node flow"
run_checks() { ( cd "$1" && shift && env "$@" bash "$kit/checks.sh" ) 2>&1; }
mkdir "$scratch/checks-cmd"
out=$(run_checks "$scratch/checks-cmd" CHECKS_COMMAND='echo ran > marker'); code=$?
check "CHECKS_COMMAND runs from the project root" [ "$code" -eq 0 -a -e "$scratch/checks-cmd/marker" ]
out=$(run_checks "$scratch/checks-cmd" CHECKS_COMMAND='false; echo after > marker2'); code=$?
check "a failing step fails the check and stops it" [ "$code" -ne 0 -a ! -e "$scratch/checks-cmd/marker2" ]
mkdir "$scratch/checks-node"
echo '{"scripts":{"lint":"x"}}' > "$scratch/checks-node/package.json"; : > "$scratch/checks-node/package-lock.json"
out=$(run_checks "$scratch/checks-node" CHECKS_DRY_RUN=1 CHECKS_SCRIPTS="lint typecheck"); code=$?; printf '%s\n' "$out"
check "the Node flow installs" grep -qxF "+ npm ci" <<<"$out"
check "the Node flow runs the scripts that exist" grep -qxF "+ npm run lint" <<<"$out"
check "the Node flow skips the ones that do not" grep -qF 'no "typecheck" script' <<<"$out"
out=$(run_checks "$scratch/checks-node" CHECKS_DRY_RUN=1 CHECKS_COMMAND='echo mine'); printf '%s\n' "$out"
check "CHECKS_COMMAND replaces the Node flow" not grep -qF "npm" <<<"$out"
mkdir "$scratch/checks-none"
out=$(run_checks "$scratch/checks-none"); code=$?
check "no package.json, no command: passes with a notice" [ "$code" -eq 0 ]
check "it says so" grep -qF "No package.json found" <<<"$out"
check "the workflow moves the kit out of the workspace before the checks" \
  grep -qF 'mv .release-kit "$RUNNER_TEMP/release-kit"' "$kit/.github/workflows/pr-checks.yml"
check "the caller passes CHECKS_COMMAND" grep -qF 'checks_command: ${{ vars.CHECKS_COMMAND }}' "$kit/workflows/pr-checks.yml"
```

- [ ] **Step 2:** rodar → a seção 22 dá `✗ MISS`.
- [ ] **Step 3:** criar `checks.sh`: `set -euo pipefail`; se `CHECKS_COMMAND` não é vazio, imprime `+ $CHECKS_COMMAND` e faz `exec bash -euo pipefail -c "$CHECKS_COMMAND"`; senão, o script de hoje do job `checks` (`.github/workflows/pr-checks.yml` ~41–73), copiado sem mudança.
- [ ] **Step 4:** `.github/workflows/pr-checks.yml`: input `checks_command` (string, default `''`). No job `checks`, depois do checkout do projeto: checkout do kit em `.release-kit` (o mesmo bloco do job `conventions`), um passo `mv .release-kit "$RUNNER_TEMP/release-kit"`, e o passo final roda `bash "$RUNNER_TEMP/release-kit/checks.sh"` com `CHECKS_DIRS`, `CHECKS_SCRIPTS` e `CHECKS_COMMAND` no `env`. O job `conventions` não muda.
- [ ] **Step 5:** `workflows/pr-checks.yml`: passar `checks_command: ${{ vars.CHECKS_COMMAND }}` e descrever a variável no comentário do topo.
- [ ] **Step 6:** rodar → `✓ all expectations met`.
- [ ] **Step 7:** commit: `feat: run the project's own command in the checks job`.

### Task 2.3: `install.sh` com um comando

**Status:** ⏳ pending

**Files:** Modify `install.sh`, `test/fixtures.sh` (seção 23)

**Interfaces:** Consumes: `workflows/deploy.yml` (Task 1.3).

Decisões:
- Uso: `install.sh [<target-repo-dir>] [--deploy] [--force] [--kit-ref <ref>]`. Sem destino: a pasta atual.
- **Modo local:** `${BASH_SOURCE[0]}` é um arquivo e a pasta dele tem `workflows/release.yml`, e `RELEASE_KIT_RAW_BASE` não está definido. **Modo download:** qualquer outro caso; cada arquivo vem de `${RELEASE_KIT_RAW_BASE:-https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/<kit_ref>}/<arquivo>` com `curl -fsSL`, para a pasta temporária que já existe hoje. Nada é copiado para o projeto antes de todos os arquivos estarem nela.
- **Modo deploy:** `--deploy`, ou o projeto tem `.github/workflows/deploy.yml`, ou o `.github/workflows/release.yml` dele contém `cut-hotfix, deploy`. Nesse modo a lista ganha `workflows/deploy.yml|.github/workflows/deploy.yml`.
- A troca de `@v1` por `@<kit_ref>` vale para todo `workflows/*`.
- Texto impresso: no item 5, linhas comentadas para `CHECKS_COMMAND` (`'make lint'`) e `TICKET_PATTERN` (`none`). Com deploy, um item 6 com: `DEPLOY_COMMAND` (script próprio); `DEPLOY_URL` + secret `DEPLOY_TOKEN` (Cubeship); `DEPLOY_TEST_APPS` e `DEPLOY_PROD_APPS` (os dois). Sem deploy, a linha `Deploys are off. To let the kit deploy too, run this again with --deploy.`
- O bloco de upgrade da instalação antiga (`.github/scripts/release.mjs`) não muda.

- [ ] **Step 1: seção 23 (sem `fresh`).** `newrepo <nome>` cria `$scratch/<nome>` com `git init --quiet` e `git remote add origin https://github.com/example/proj.git`. Todas as chamadas levam `RELEASE_KIT_OWNER_TYPE=Organization` no ambiente, para o script não chamar o `gh`. `kiturl` é a pasta do kit como URL `file://` (no Windows, a partir de `pwd -W`).

| Cenário | Verificações (`check`) |
|:--|:--|
| `install.sh inst-a` | sai 0; existem `release.yml`, `pr-checks.yml`, os 3 rulesets, `RELEASING.md`; **não** existe `deploy.yml`; a saída tem `Deploys are off`; o `release.yml` instalado não tem `cut-hotfix, deploy` |
| `install.sh inst-b --deploy` | existe `deploy.yml`; a saída tem `DEPLOY_COMMAND` e `DEPLOY_PROD_APPS` |
| `inst-c` com um `release.yml` que só tem a linha `options: [cut-release, cut-hotfix, deploy]` | sem `--force`: sai 1 e a saída tem `re-run with --force`. Com `--force`: existe `deploy.yml` e o `release.yml` novo tem `options: [cut-release, cut-hotfix]` |
| `(cd inst-d && install.sh)` | `inst-d/.github/workflows/release.yml` existe |
| `RELEASE_KIT_RAW_BASE=$kiturl install.sh inst-e --deploy` | `diff -r inst-b/.github inst-e/.github` e `cmp inst-b/RELEASING.md inst-e/RELEASING.md` saem 0 |
| `RELEASE_KIT_RAW_BASE=file:///no/such/kit install.sh inst-f` | sai ≠ 0; `inst-f/.github` e `inst-f/RELEASING.md` não existem |
| `install.sh inst-g --deploy --kit-ref feat/x` | `release.yml`, `deploy.yml` e `pr-checks.yml` instalados têm `@feat/x` e nenhum `@v1` |
| `bash -n install.sh` | sai 0 |

- [ ] **Step 2:** rodar → a seção 23 dá `✗ MISS`.
- [ ] **Step 3:** implementar em `install.sh`.
- [ ] **Step 4:** rodar → `✓ all expectations met`.
- [ ] **Step 5:** commit: `feat: install with one command, straight from GitHub`.

### Task 2.4: docs e licença

**Status:** ⏳ pending

**Files:** Modify `README.md`, `RELEASING.md`, `release.mjs` (só o cabeçalho ~1–41), `test/fixtures.sh` (comentário do topo e 2 `check`); Create `LICENSE`.

- [ ] **Step 1:** `LICENSE`: texto MIT padrão, `Copyright (c) 2026 Kaina Ribeiro`.
- [ ] **Step 2:** `README.md`:
  - "Add it to a project", passo 1: o comando único do spec (seção 5), rodado da pasta do projeto; `--deploy` para ligar o deploy; o modo com o clone ao lado fica como alternativa.
  - "Before you start": sai o clone do kit; entra `curl`.
  - Passo 4, "Deploys (optional)": sem ele o kit só cria tags. Como ligar (`--deploy`), tabela dos dois adaptadores com as variáveis de cada um, e o contrato do `command` (as duas chamadas, as 4 variáveis `RELEASE_*`, o que significa `current` vazio).
  - Passo 3, item 5: `CHECKS_COMMAND` e `TICKET_PATTERN=none`.
  - Seção nova curta, "Versions and trust": em `@v1` cada versão nova do kit roda no repo de quem instalou, com os tokens dele; `--kit-ref v1.2.0` fixa uma versão.
  - "Reference": a tabela de arquivos ganha `adapters/`, `checks.sh`, `workflows/deploy.yml`; a tabela de eventos diz Actions → Deploy; "Guards" sem Cubeship no texto genérico. "Test" cita as seções 17 a 23.
- [ ] **Step 3:** `RELEASING.md`:
  - "Deploys": texto genérico (alvos, adaptador); o parágrafo do container que precisa ficar de pé vira a subseção "Cubeship adapter"; subseção "Command adapter" com o contrato.
  - Todo "Actions → Release → `deploy`" vira "Actions → Deploy" (procedimentos 4.2 e 5, "When the automation refuses").
  - "Setup": item 5 ganha `CHECKS_COMMAND` e `none`; item 6 descreve `--deploy`, os dois adaptadores e os nomes novos, e diz que `CUBESHIP_URL`/`CUBESHIP_TOKEN` continuam aceitos; "Files" cita o `deploy.yml`.
  - "Naming": uma linha para o modo sem ticket.
- [ ] **Step 4:** cabeçalho do `release.mjs`: `deploy` descrito como "through the deploy adapter"; a lista de variáveis de ambiente com os nomes novos e os antigos como aceitos.
- [ ] **Step 5:** dois `check` no fim da seção 20: `README.md` contém a linha do comando único (`raw.githubusercontent.com/Kaina-Ribeiro/release-kit/v1/install.sh`), e `RELEASING.md` não contém `Actions → Release → \`deploy\``.
- [ ] **Step 6:** rodar → `✓ all expectations met`. Ler os dois arquivos renderizados uma vez, de ponta a ponta.
- [ ] **Step 7:** commit: `docs: describe tags-only installs, deploy adapters and the one-line install`.

---

## Fase 3: rascunho no GitHub, PR e release (cada passo com o "sim")

### Task 3.1: ciclo no sandbox

**Status:** ⏳ pending

Sandbox: `Kaina-Ribeiro/release-kit-sandbox` (privado, usado no hardening).

- [ ] **Step 1:** com o "sim", push de `feat/generic-kit`.
- [ ] **Step 2:** num clone limpo do sandbox, instalar com o comando único apontando para o branch: `curl -fsSL https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/feat/generic-kit/install.sh | bash -s -- . --force --kit-ref feat/generic-kit`. Conferir os arquivos e, com o "sim", abrir e mergear o PR deles.
- [ ] **Step 3 (só tags):** Actions → Release mostra só `cut-release`, `cut-hotfix`, `version`, `dry_run`. Não existe workflow Deploy. Um ciclo `cut-release` → PR → rc → merge → final fica verde, sem job de deploy rodando.
- [ ] **Step 4 (checks e tickets):** variáveis `CHECKS_COMMAND=echo ok` e `TICKET_PATTERN=none`; um PR `feat/sandbox-check` com título `feat: check the generic kit` passa nos dois checks. Depois, `CHECKS_COMMAND=false` reprova `pr-checks / checks`.
- [ ] **Step 5 (deploy por comando):** reinstalar com `--deploy`; um `scripts/deploy.sh` de teste no sandbox (`deploy` só imprime o que recebeu; `current` não imprime nada, porque um runner não guarda estado de um job para o outro); variáveis `DEPLOY_COMMAND`, `DEPLOY_TEST_APPS=web`, `DEPLOY_PROD_APPS=web`. O rc seguinte roda o `deploy-test`; Actions → Deploy, stage `prod`, fica verde; o `final` seguinte mostra o aviso `does not say what it runs` e cria a tag. Conferir que `permissions: contents: read` basta no `deploy.yml`; se o GitHub recusar, usar o bloco de permissões do `release.yml` e anotar.
- [ ] **Step 6:** anotar em **Notas** os links dos runs e qualquer desvio.

### Task 3.2: PR, release `v1.2.0` e conferência

**Status:** ⏳ pending

- [ ] **Step 1:** `git status`, `git branch -vv`, conferir o branch remoto. Com o "sim", abrir o PR `feat/generic-kit` → `master`; CI do kit verde.
- [ ] **Step 2:** com o "sim", merge; apagar o branch local e o remoto; `master` local igual à `origin/master`.
- [ ] **Step 3:** com o "sim", Actions → Kit release, `version` = `1.2.0`, primeiro em dry run, depois de verdade. `v1` passa a apontar para `v1.2.0`.
- [ ] **Step 4:** conferir, sem disparar nada: o próximo rc de um dos 3 repos (`npac-corporation-crm`, `totem-comanda`, `ari-ribeiro-karaoke`) sai e o `deploy-test` dele fica verde. Se falhar: PR nesse repo fixando `@v1.1.0`, e corrigir o kit.
- [ ] **Step 5:** atualizar Status e Notas; relatar em até 5 linhas.

---

## Notas

(vazio; cada fase registra aqui os commits, os desvios do plano e o que ficou em aberto)
