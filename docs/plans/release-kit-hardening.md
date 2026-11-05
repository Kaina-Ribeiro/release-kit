# release-kit hardening: plano de implementação

> **Para agentes:** use superpowers:executing-plans (ou superpowers:subagent-driven-development) tarefa a tarefa.
> Passos em checkbox (`- [ ]`). Ao terminar uma tarefa, atualize a linha **Status** dela e a seção **Notas**.

**Goal:** implementar o `SPEC.md`: bugs B1–B6 com testes que verificam, tags de hotfix `-hf`, o kit fixado em `@v1` nos 3 repos e uma issue quando a automação falha.

**Architecture:** a lógica continua em `release.mjs` (Node, sem dependências) e nos workflows. A Fase 3 move os workflows para workflows reutilizáveis dentro do próprio kit. Os testes (`test/fixtures.sh`) rodam o `release.mjs` real contra repos git descartáveis, com mocks HTTP do Cubeship (já existe) e do GitHub (Fase 4).

**Tech Stack:** Node 18+ ESM sem dependências, bash, git, GitHub Actions.

**Spec:** `SPEC.md` (aprovado em 2026-11-05). Leia o SPEC e este plano antes de começar.

## Como executar (regras do dono)

- **Uma sessão nova por fase**, na ordem 1 → 2 → 3 → 4. A sessão faz só a sua fase, atualiza Status e Notas e relata em até 5 linhas.
- Cada fase tem um branch próprio, criado a partir da `master` atualizada: F1 `fix/kit-guards`, F2 `feat/hotfix-hf-tags`, F3 `feat/reusable-workflows`, F4 `feat/failure-issues`.
- O primeiro commit da F1 inclui `SPEC.md` e este plano.
- **Sem o "sim" do dono no chat:** nada de push, PR, merge, criação/movimento de tag, criação de repo nem mudança de ruleset ou configuração.
- Commits em Conventional Commits, inglês, minúsculo, no imperativo, no padrão do repo: `fix: fail a deploy whose container does not stay up`.
- Status: `⏳ pending` · `🔄 in progress` · `✅ done (<commit>)` · `❌ blocked: <motivo>`.

## Global Constraints

- `release.mjs`: Node 18+, zero dependências, ESM. Toda ação respeita `--dry-run`: imprime `[dry-run] would …` e não muda nada.
- Um erro esperado é sempre `fail(msg)` (classe `Failure`, sem stack). As mensagens do kit são em inglês, e as que o SPEC fixa são copiadas literalmente.
- Nada específico de um repositório entra no kit.
- Teste de cada fase: `bash test/fixtures.sh "" "$(mktemp -d)"` sai com 0 e termina em `✓ all expectations met`.
- No Windows, os testes rodam pelo Git Bash.
- Linhas citadas como `~N` são do `release.mjs` de 2026-11-05. Elas mudam a cada tarefa, então o nome da função é a referência.

## Review Focus

1. **Tags legadas e manuais misturadas** (`v0.2.0-rc.3`, hotfix sem `-hf`, o `v1.0` manual do ari): `status`, `cut-*` e `rc` funcionam e ignoram o que não é tag de release. → teste na Task 2.1.
2. **Default branch que não se chama `main`** (o totem usa `master`): as mensagens e o sync PR do B6 usam o nome real. → a verificação da Task 1.7 roda o teste com o próprio kit como fonte.
3. **Re-run do `final`** depois que a tag já existe: não falha e continua sugerindo o sync. → Task 1.7.
4. **API do GitHub fora do ar no `final`** (comentar ou abrir o sync): vira aviso, não erro, porque a tag já saiu. → Task 1.7.
5. **Hotfix com um rc legado sem `-hf` seguido de um rc `-hf`:** o final segue o nome do último rc. → Task 2.1.

---

## Fase 1: testes que verificam + B1–B6 (branch `fix/kit-guards`)

### Task 1.1: harness que verifica + CI do kit (B8)

**Status:** ✅ done (cde6ea8; guarda contra push em ea8ee0a)

**Files:**
- Modify: `test/fixtures.sh`
- Create: `.github/workflows/test.yml`
- Modify: `README.md` (seção "Test")

**Interfaces:** Produces (bash, em `fixtures.sh`), usadas por todas as tarefas seguintes:
- `expect ok|fail <args…>`: já existe; roda `node release.mjs <args>` e conta MISS se o exit code não bate.
- `expect_out ok|fail "<texto>" <args…>`: como `expect`, e também conta MISS se stdout+stderr não contém `<texto>` (`grep -F`).
- `check "<descrição>" <comando…>`: roda o comando e conta MISS se ele sai ≠ 0. Serve para conferir arquivos de output e o estado do git.
- `fresh <nome>`: cria `$scratch/<nome>/remote.git` (um bare de `$src`) e `$scratch/<nome>/work`, faz `cd` para o work, configura user, email e `core.autocrlf false`, e redefine `def`. Toda seção nova começa com `fresh`.
- Os helpers `tag`, `branch`, `commit_on` e `merge_into_default` continuam iguais e operam no diretório atual.
- Com `$1` vazio, o script cria `$scratch/source` (`git init -b main`, um commit com `README`) e usa esse repo como `$src`.
- As seções novas (11 em diante) entram depois da seção 10 e antes do bloco final que conta os `misses`.

- [ ] **Step 1:** implementar o `$1` opcional, `expect_out`, `check` e `fresh`.
- [ ] **Step 2:** converter cada `r` em `expect`/`expect_out` com o resultado de hoje. A tabela abaixo é a base medida em 2026-11-05 (57 passos, todos batendo). Use `expect_out` com o texto entre aspas:

| Seção | Comando | Esperado |
|:--|:--|:--|
| 2 | 1º `rc --branch release/v0.2` | ok `"release/v0.2 → v0.2.0-rc (first rc)"` |
| 2 | 2º `rc` (com `GITHUB_OUTPUT`) | ok `"is already v0.2.0-rc; nothing to do"` + `check` que o arquivo tem a linha `tag=v0.2.0-rc` |
| 2b | `rc --branch release/v0.3` | ok `"no new code on release/v0.3, no rc"` + `check` com a linha `tag=` vazia |
| 2b | `cut-release --version 0.2` | fail `"must be newer than release/v0.3"` |
| 3 | os 3 títulos/branches inválidos | fail (`expect fail`) |
| 4 | 1º `final --head release/v0.2` | fail `"differs from v0.2.1-rc"` |
| 4 | 2º `final` | ok `"→ v0.2.2 (same code as v0.2.2-rc)"` |
| 4 | `rc --branch release/v0.2` depois do final | fail `"already shipped as v0.2.2"` |
| 5 | `cut-hotfix` | ok `"in prod: v0.2.2; the hotfix's next rc will be v0.2.3-rc"` |
| 5 | `conventions release/v0.3 → $def` | fail `"is behind $def"` |
| 6 | `deploy-check v0.2.3-rc --prod` | fail `"is not the last rc"` |
| 6 | `deploy-check release/v0.3` | fail `"is not a release tag"` |
| 8 | `deploy --stage prod v0.3.0-rc.1` | fail `"(that is v0.3.1-rc)"` |
| 9 | 1º `final --head release/v0.3` | fail `"prod does not run v0.3.2-rc"` |
| 9 | 2º `final` (depois do deploy prod) | ok `"✓ prod runs v0.3.2-rc"` |

  Os outros passos são `expect ok`. As seções 3b, 6 e 7 já mostram o texto certo no log de hoje: copie a primeira linha.
- [ ] **Step 3:** rodar `bash test/fixtures.sh "" "$(mktemp -d)"` → exit 0, `✓ all expectations met`.
- [ ] **Step 4:** provar que verifica: troque um `expect ok` por `expect fail`, rode → exit 1 com `✗ MISS`. Desfaça a troca.
- [ ] **Step 5:** criar `.github/workflows/test.yml`. Gatilhos: `pull_request` e `push` em `master`. Job `fixtures` em `ubuntu-latest`: `actions/checkout@v5` (fetch-depth 0), `actions/setup-node@v5` (node `lts/*`, `package-manager-cache: false`), `bash test/fixtures.sh "" "$RUNNER_TEMP/fx"`.
- [ ] **Step 6:** README, seção Test: `<source-repo>` é opcional, e a falha de qualquer `expect` faz o script sair com 1.
- [ ] **Step 7:** commit (`SPEC.md`, este plano e os arquivos acima): `test: make every fixture step assert its outcome`.

### Task 1.2: B3, fetch com tag local velha + mensagens do git

**Status:** ✅ done (421fbce)

**Files:** Modify `release.mjs` (`git` ~80, `state` ~139); Modify `test/fixtures.sh` (seção nova 11)

**Interfaces:** Produces: `git(...args)` lança `Failure("git <args> failed: <stderr do git, trim>")`. `gitOk` continua devolvendo `false` em qualquer erro.

- [ ] **Step 1: teste (seção 11)**
```bash
echo; echo "=== 11. B3: a stale local tag does not break the fetch; git errors read as git's"
fresh b3
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc origin/release/v0.1
c=$(git rev-parse 'v0.1.0-rc^{commit}'); git tag -d v0.1.0-rc >/dev/null; git tag v0.1.0-rc "$c"
expect ok status
git remote set-url origin "$scratch/nowhere.git"
expect_out fail "git fetch origin --tags --prune --force failed: fatal:" status
```
- [ ] **Step 2:** rodar → 2 MISS.
- [ ] **Step 3:** em `state`, o fetch vira `git('fetch', 'origin', '--tags', '--prune', '--force')`, sem `--quiet`. Em `git`, capturar o erro e lançar a `Failure` acima.
- [ ] **Step 4:** rodar → exit 0.
- [ ] **Step 5:** commit `fix: let the tag fetch replace stale local tags and report git's own error`.

### Task 1.3: B5, uma linha só faz PR para uma linha mais nova

**Status:** ✅ done (f3f0705)

**Files:** Modify `release.mjs` (`cmdConventions` ~627); `test/fixtures.sh` (seções 3 e 5); `RELEASING.md` (Naming)

- [ ] **Step 1: testes**
  - Na seção 3: `expect_out fail "release/v0.3 can merge only into $def or a newer line; release/v0.2 is older." conventions --head release/v0.3 --base release/v0.2 --title "chore(sync): merge release/v0.3 into release/v0.2"`.
  - Na seção 5, depois que o `hotfix/v0.2` existe: `expect_out fail "is older" conventions --head release/v0.3 --base hotfix/v0.2 --title "chore(sync): merge release/v0.3 into hotfix/v0.2"` e `expect ok conventions --head hotfix/v0.2 --base release/v0.3 --title "chore(sync): merge hotfix/v0.2 into release/v0.3"`.
- [ ] **Step 2:** rodar → 2 MISS (as duas recusas).
- [ ] **Step 3:** em `cmdConventions`, quando head e base são linhas e `cmpLine(baseLine, headLine) <= 0`, empurrar o erro `${head} can merge only into ${def} or a newer line; ${base} is older.`
- [ ] **Step 4:** rodar → exit 0. `RELEASING.md` (Naming) ganha: "a version line merges only into the default branch or a newer line".
- [ ] **Step 5:** commit `fix: let a version line merge only into a newer line`.

### Task 1.4: B2, prod recusa um rc sem o que o default branch tem

**Status:** ✅ done (55ecbe5)

**Files:** Modify `release.mjs` (`checkDeploy` ~668, helper novo `lineOf`); `test/fixtures.sh` (seções 7, 8 e nova 12); `RELEASING.md` (Deploys, Procedure 4)

**Interfaces:** Produces: `lineOf(tag): string`, que devolve o nome do branch `release/` ou `hotfix/` com o mesmo X.Y em `state().branches`, ou `` `the v${X}.${Y} line` `` se nenhum existir.

- [ ] **Step 1: teste (seção 12)**
```bash
echo; echo "=== 12. B2: prod refuses an rc that lacks what the default branch has"
fresh b2
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc origin/release/v0.1
merge_into_default release/v0.1; tag v0.1.0 "origin/$def"
branch release/v0.2 "origin/$def"; commit_on release/v0.2 "feat(ABC-2): two"; tag v0.2.0-rc origin/release/v0.2
branch hotfix/v0.1 v0.1.0; commit_on hotfix/v0.1 "fix(ABC-3): prod bug"; tag v0.1.1-rc origin/hotfix/v0.1
expect ok deploy-check v0.1.1-rc --prod
merge_into_default hotfix/v0.1; tag v0.1.1 "origin/$def"
expect_out fail "v0.2.0-rc lacks what $def has" deploy-check v0.2.0-rc --prod
expect ok deploy-check v0.2.0-rc
git checkout --quiet -B release/v0.2 origin/release/v0.2
git merge --quiet --no-ff -X ours "origin/$def" -m "Merge $def into release/v0.2"; git push --quiet origin release/v0.2
tag v0.2.1-rc origin/release/v0.2
expect ok deploy-check v0.2.1-rc --prod
expect ok deploy-check v0.1.1 --prod
```
- [ ] **Step 2:** rodar → MISS em `v0.2.0-rc lacks`.
- [ ] **Step 3:** em `checkDeploy`, para um rc em prod, depois da checagem de "last rc": se `!isAncestor(remoteRef(def), name)`, falhar com a mensagem do SPEC:
  `` `${name} lacks what ${def} has (${def} at ${sha12}, prod ${prodTag()?.name ?? 'nothing'}): prod would lose it. Merge the open sync PR (or ${def}) into ${lineOf(tag)}, then deploy the new rc.` ``
  O rollback para um final não muda.
- [ ] **Step 4:** a história principal muda, e é o comportamento novo certo: na seção 7, `deploy-check v0.3.0-rc.1 --prod` → `expect_out fail "lacks what $def has"`. Na seção 8, `deploy-check v0.3.1-rc --prod` → o mesmo. A `release/v0.3` ainda não tem o hotfix v0.2.3; a seção 9 faz o merge e volta a passar.
- [ ] **Step 5:** rodar → exit 0. `RELEASING.md`, Deploys: "Prod: the last rc of an open line **that contains the default branch**". Procedure 4: antes do deploy prod, faça o merge do sync PR aberto.
- [ ] **Step 6:** commit `fix: refuse a prod deploy of an rc that lacks the default branch`.

### Task 1.5: B1, deploy sem tag usa o ref do run

**Status:** ✅ done (56f63fd)

**Files:** Modify `release.mjs` (`defaultDeployTag` ~708, helper novo `openLines`); `workflows/release.yml` (descrição do input `tag`); `test/fixtures.sh` (seções 8, 9 e nova 13); `RELEASING.md` (Procedures 4.2 e 5)

**Interfaces:**
- Produces: `openLines(): Line[]`, os `release/*` existentes ainda não entregues (`finalsOf` vazio) mais todos os `hotfix/*` existentes, em ordem `cmpLine`.
- Produces: `defaultDeployTag(stage): string | null`. A ordem de decisão:
  1. `--branch` → como hoje.
  2. `GITHUB_REF_TYPE === 'tag'` → `GITHUB_REF_NAME`.
  3. `parseLine(GITHUB_REF_NAME)` → o último rc dessa linha.
  4. Senão, pelas linhas abertas:
     - 1 linha → o último rc dela (ou `fail(`${name} has no rc to deploy`)`).
     - 0 linhas → `fail('no open line; pass the tag to deploy')`.
     - mais de uma → `fail(`${n} lines are open (${lista}); pass the tag or run from the line's branch`)`, com `lista` = `name: lastRc ?? 'no rc'` separados por `, `.

- [ ] **Step 1: teste (seção 13)**
```bash
echo; echo "=== 13. B1: a deploy without a tag takes the line or tag the run starts from"
fresh b1
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc origin/release/v0.1
merge_into_default release/v0.1; tag v0.1.0 "origin/$def"; git push --quiet origin --delete release/v0.1
branch release/v0.2 "origin/$def"; commit_on release/v0.2 "feat(ABC-2): two"; tag v0.2.0-rc origin/release/v0.2
export DEPLOY_PROD_APPS=demo/prod/api DEPLOY_TEST_APPS=demo/test/api
expect_out ok "deploying v0.2.0-rc to prod" deploy --stage prod --dry-run
branch hotfix/v0.1 v0.1.0; commit_on hotfix/v0.1 "fix(ABC-3): prod bug"; tag v0.1.1-rc origin/hotfix/v0.1
GITHUB_REF_TYPE=branch GITHUB_REF_NAME=hotfix/v0.1 expect_out ok "deploying v0.1.1-rc to prod" deploy --stage prod --dry-run
GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v0.2.0-rc expect_out ok "deploying v0.2.0-rc to test" deploy --stage test --dry-run
GITHUB_REF_TYPE=branch GITHUB_REF_NAME="$def" expect_out fail "2 lines are open (hotfix/v0.1: v0.1.1-rc, release/v0.2: v0.2.0-rc)" deploy --stage prod --dry-run
unset DEPLOY_PROD_APPS DEPLOY_TEST_APPS
```
- [ ] **Step 2:** rodar → MISS no hotfix (hoje dá `v0.2.0-rc`) e na recusa.
- [ ] **Step 3:** implementar `openLines` e a nova `defaultDeployTag`.
- [ ] **Step 4:** ajustar a história principal:
  - Seção 8, `deploy --stage test --dry-run` sem branch → `expect_out fail "2 lines are open"` (o `hotfix/v0.2` ainda existe no fixture).
  - Seção 9, `deploy --stage prod` → passa a ser `deploy --stage prod --branch release/v0.3`.
- [ ] **Step 5:** em `workflows/release.yml`, a descrição do input `tag` vira `'deploy only: the tag. Empty = last rc of the branch you run from (or the tag you run from).'`. `RELEASING.md` 4.2 e 5: "run from the line's branch, tag empty".
- [ ] **Step 6:** rodar → exit 0. Commit `fix: deploy the line or tag the run starts from when no tag is given`.

### Task 1.6: B4, a corrida do cut não tira o rc da linha antiga

**Status:** ✅ done (7e9e358)

**Files:** Modify `release.mjs` (`cmdRc` ~482, `cmdCutRelease` ~572, helper novo `blockingTagsOn`); `test/fixtures.sh` (seção nova 14); `RELEASING.md` (Procedure 3)

**Interfaces:** Produces: `blockingTagsOn(sha, line): Tag[]`, as tags no `sha` que são um final ou um rc de uma linha mais velha (`cmpLine(tag, line) < 0`). `releaseTagsOn(sha)` continua existindo para o cut.

- [ ] **Step 1: teste (seção 14)**
```bash
echo; echo "=== 14. B4: cutting a release does not take the rc of the line it is cut from"
fresh b4
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"
expect_out fail "release/v0.1's head" cut-release --dry-run
tag v0.1.0-rc origin/release/v0.1
expect ok cut-release --dry-run
commit_on release/v0.1 "fix(ABC-2): late"
branch release/v0.2 origin/release/v0.1
tag v0.2.0-rc origin/release/v0.2
expect_out ok "release/v0.1 → v0.1.1-rc" rc --branch release/v0.1 --dry-run
```
- [ ] **Step 2:** rodar → 2 MISS.
- [ ] **Step 3:**
  - `cmdRc` passa a usar `blockingTagsOn(sha, line)` no lugar de `releaseTagsOn(sha)` (a mensagem "no new code" não muda).
  - `cmdCutRelease`, quando a origem é uma release aberta e `releaseTagsOn(commitOf(remoteRef(newest.name)))` vem vazio, falha com:
    `` `${newest.name}'s head ${sha12} has no rc yet (its Release run may still be running); wait for it, then cut again.` ``
- [ ] **Step 4:** rodar → exit 0. As seções 2b e 5 (pular o commit de um cut) continuam passando. `RELEASING.md` 3: "cut only after the newest open release's last push got its rc".
- [ ] **Step 5:** commit `fix: keep a line's rc when a newer line tags the same commit first`.

### Task 1.7: B6, sync do default branch antes de apagar a linha entregue

**Status:** ✅ done (2aaeb2b; texto do comentário com o sync PR recusado em b82a802)

**Files:** Modify `release.mjs` (`openSyncPr` ~255, `cmdFinal` ~517, `cmdConventions` ~627, funções novas `commentOnOpenPrs` e `afterShip`); `test/fixtures.sh` (seções 3, 4, 5); `RELEASING.md` (Procedures 4.3, 5 e 6; "When the automation refuses")

**Interfaces:**
- `openSyncPr(source, target): Promise<number | null>`: o número do PR (o existente ou o novo), ou `null` em dry-run.
- `commentOnOpenPrs(head, body): Promise<void>`: comenta em cada PR aberto com esse head.
  - Em dry-run: `would comment on open PRs from ${head}: "${body}"`.
  - Sem token em dry-run: `(no GitHub token: skipping the check for open PRs from ${head})`.
  - Erro de API → `warn`, nunca falha.
- `afterShip(head, tag, sha): Promise<void>`: chamada pelos **dois** caminhos de `cmdFinal` (tag nova e re-run com a tag já existente):
  1. `next = openReleases().find((r) => r.name !== head)`. Atenção: o cache do estado ainda vê `head` como aberta.
  2. Se `next` existe e `!isAncestor(sha, remoteRef(next.name))` → `pr = await openSyncPr(def, next.name)`.
  3. `commentOnOpenPrs(head, `Closed because ${head} shipped as ${tag}; its changes reach ${next.name} through #${pr}.`)`. Em dry-run, `#${pr}` vira `the sync PR`; sem `next`, o texto vira `its changes are in ${def}.`
  4. `deleteBranch(head)`.
  - Os passos 2 e 3 são embrulhados para virar `warn` em qualquer erro.
- `cmdConventions`: com `head === def` e base uma linha, aplica só a regra de título Conventional Commits das linhas.

- [ ] **Step 1: testes**
  - Seção 3:
    - `expect ok conventions --head "$def" --base release/v0.2 --title "chore(sync): merge $def into release/v0.2"`
    - `expect_out fail "is not Conventional Commits" conventions --head "$def" --base release/v0.2 --title "merge"`
  - Seção 4:
    - 2º `final` → também `expect_out ok "would open PR \"chore(sync): merge $def into release/v0.3\""`.
    - Depois do `tag v0.2.2`: `expect_out ok "already on" final --head release/v0.2 --dry-run` (re-run, Review Focus 3).
    - E `GH_TOKEN=x GITHUB_API_URL=http://127.0.0.1:9 expect_out ok "warning:" final --head release/v0.2 --dry-run` (API fora do ar, Review Focus 4).
  - Seção 5: o `final` do hotfix → `expect_out ok "would open PR \"chore(sync): merge $def into release/v0.3\""`.
- [ ] **Step 2:** rodar → MISS nos passos novos.
- [ ] **Step 3:** implementar as interfaces acima.
- [ ] **Step 4:** rodar → exit 0. Rodar também `bash test/fixtures.sh . "$(mktemp -d)"`, com o kit como fonte, para ter um default branch que não se chama `main` (Review Focus 2) → exit 0.
- [ ] **Step 5:** `RELEASING.md`:
  - Procedure 6 inclui os sync PRs `merge <default> into <release>`.
  - Em "final refused, differs", o conserto vira "merge the sync PR from the default branch".
- [ ] **Step 6:** commit `fix: sync the default branch into the next release before deleting a shipped line`.

---

## Fase 2: tags de hotfix `-hf` (branch `feat/hotfix-hf-tags`)

### Task 2.1: nomes `-hf-rc` / `-hf` e final = último rc sem `-rc`

**Status:** ✅ done (3e268b2)

**Files:**
- Modify `release.mjs`: cabeçalho, `TAG_RE` ~35, `parseTag` ~118, `fmt`/`fmtRc` ~133, `rcsOf` ~147, `cmdRc`, `cmdFinal`, `cmdCutRelease`, `cmdCutHotfix`, `checkDeploy`, `cmdStatus`
- Modify `test/fixtures.sh` (seções 5, 6 e nova 15)
- Modify `RELEASING.md` (Model, Procedure 5, Deploys) e `README.md` (tabela)

**Interfaces:**
- `TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-hf)?(-rc(?:\.(\d+))?)?$/`
- `parseTag(name)` → `{ name, major, minor, patch, hf: boolean, rc: number | null } | null`
- `rcName(line, patch): string` → `vX.Y.Z-rc` para release, `vX.Y.Z-hf-rc` para hotfix. Substitui todo uso de `fmtRc`.
- `finalName(rcTag): string` → `rcTag.name.replace(/-rc(?:\.\d+)?$/, '')`. Substitui `fmt(lastRc…)` no `final` e na mensagem do `checkDeploy`.
- `rcOf(finalTag): Tag | undefined` → o último rc com o mesmo major, minor, patch e `hf`. Substitui `rcsOf` no rollback.
- `cmpTag` não muda: no mesmo patch, o rc vem antes do final.
- A mensagem de tag inválida vira: `"${name}" is not a release tag (vX.Y.Z, vX.Y.Z-rc, vX.Y.Z-hf or vX.Y.Z-hf-rc); branches and other refs never deploy`.

- [ ] **Step 1: testes**
  - Seção 5:
    - `expect_out ok "hotfix/v0.2 → v0.2.3-hf-rc" rc …`, e o fixture passa a criar `tag v0.2.3-hf-rc …`.
    - `expect_out ok "→ v0.2.3-hf (same code as v0.2.3-hf-rc)" final --head hotfix/v0.2 --dry-run`, e o fixture cria `tag v0.2.3-hf …`.
    - `expect_out ok "in prod: v0.2.3-hf; the hotfix's next rc will be v0.2.4-hf-rc" cut-hotfix --dry-run`.
  - Seção 6:
    - `deploy-check v0.2.3-hf-rc` (test) → ok.
    - `deploy-check v0.2.3-hf --prod` → ok.
    - `deploy-check release/v0.3` → fail com a mensagem nova.
  - Seção 15:
```bash
echo; echo "=== 15. legacy and manual tags; a hotfix that switches to -hf mid-way"
fresh legacy
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc.1 origin/release/v0.1
merge_into_default release/v0.1; tag v0.1.0 "origin/$def"
branch hotfix/v0.1 v0.1.0; commit_on hotfix/v0.1 "fix(ABC-2): old style"; tag v0.1.1-rc origin/hotfix/v0.1
git tag v1.0 "origin/$def"; git push --quiet origin refs/tags/v1.0
expect_out ok "in prod:        v0.1.0" status
expect_out ok "release/v0.2 branches from $def" cut-release --dry-run
commit_on hotfix/v0.1 "fix(ABC-3): new style"
expect_out ok "hotfix/v0.1 → v0.1.2-hf-rc" rc --branch hotfix/v0.1 --dry-run
tag v0.1.2-hf-rc origin/hotfix/v0.1
merge_into_default hotfix/v0.1
expect_out ok "→ v0.1.2-hf (same code as v0.1.2-hf-rc)" final --head hotfix/v0.1 --dry-run
```
- [ ] **Step 2:** rodar → MISS nos nomes `-hf`.
- [ ] **Step 3:** implementar as interfaces e trocar os usos. O `checkLine`, o `prodTag` e o `finals()` passam a aceitar `-hf` sozinhos (`rc === null`). Conferir só que nenhum usa `fmt(`.
- [ ] **Step 4:** rodar → exit 0. Docs: a tabela de nomes do SPEC (Fase 2) entra em RELEASING → Model, e a Procedure 5 cita `vX.Y.Z-hf-rc` → `vX.Y.Z-hf`.
- [ ] **Step 5:** commit `feat: tag hotfix candidates vX.Y.Z-hf-rc and ship them as vX.Y.Z-hf`.

---

## Fase 3: kit fixado por versão (branch `feat/reusable-workflows`)

### Task 3.1: spike (descartável)

**Status:** ✅ done (spike `a206496` em `spike/reusable`, descartável; resultados em Notas → Spike F3). Falta só apagar `spike/reusable` (com o "sim").

- [ ] **Step 1:** no branch `spike/reusable` do kit, criar `.github/workflows/spike.yml` com `on: workflow_call` (input `command`, string) e dois jobs:
  - Job `run`: imprime `github.event_name`, `github.event.repository.full_name`, `github.ref_name`, `inputs.command`, `job.workflow_repository`, `job.workflow_sha` e `vars.SPIKE_VAR`. Depois um step `id: boom` grava `error=boom` em `GITHUB_OUTPUT` e faz `exit 1`. O job tem `outputs.error: ${{ steps.boom.outputs.error }}`.
  - Job `after`: `needs: run`, `if: always()`, imprime `needs.run.outputs.error`.
- [ ] **Step 2:** no sandbox, criar o chamador `.github/workflows/spike.yml`:
  - Gatilhos: `push`, `pull_request` (closed e opened) e `workflow_dispatch` (input `command`).
  - `permissions`: contents, pull-requests e issues write.
  - Job `checks`: `uses: Kaina-Ribeiro/release-kit/.github/workflows/spike.yml@spike/reusable`, `with: command: ${{ inputs.command }}`.
  - Criar a variável de repo `SPIKE_VAR=1`.
- [ ] **Step 3:** disparar: um push, um PR aberto e mergeado e um dispatch com `command=x`.
- [ ] **Step 4:** registrar em **Notas → Spike F3** os cinco resultados:
  1. O evento visto é o do chamador?
  2. `vars` aparece?
  3. `workflow_sha` é o commit do kit?
  4. O output do step que falhou chega no `after`?
  5. O nome exato do check do job `checks` no PR (`gh pr checks`)?
- [ ] **Step 5:** decidir:
  - (1) ou (3) "não" → **parar** e avisar o dono (plano B do SPEC: action composta).
  - (2) "não" → não muda nada (passamos tudo explicitamente).
  - (4) "não" → anotar que a Fase 4 lê o erro pela API de logs.
- [ ] **Step 6:** com o "sim", apagar `spike/reusable`. O sandbox fica para as Tasks 3.2 e 4.2.

### Task 3.2: workflows reutilizáveis + chamadores

**Status:** 🔄 in progress (bee9df5; falta o ciclo no sandbox)

**Files:**
- Create: `.github/workflows/release.yml` e `.github/workflows/pr-checks.yml` (reutilizáveis)
- Modify: `workflows/release.yml` e `workflows/pr-checks.yml` (viram chamadores)
- Modify: `install.sh` (flag `--kit-ref`)

**Interfaces:**
- Inputs (`workflow_call`) do `release.yml` reutilizável, todos string salvo indicação: `command` (''), `version` (''), `stage` ('test'), `tag` (''), `dry_run` (boolean, false), `cubeship_url`, `deploy_test_apps`, `deploy_prod_apps`, `health_stable_s`, `health_wait_s` (todos ''). Secrets: `release_token`, `cubeship_token` (`required: false`).
- Inputs do `pr-checks.yml` reutilizável: `checks_dirs` (''), `checks_scripts` ('lint typecheck type-check'), `ticket_pattern` ('').
- Cada job faz checkout do repo chamador (como hoje) e depois `actions/checkout@v5` com `repository: ${{ job.workflow_repository }}`, `ref: ${{ job.workflow_sha }}` e `path: .release-kit`. Em seguida roda `node .release-kit/release.mjs …`.
- Jobs, condições, concurrency e steps são idênticos aos de hoje, com `vars.*`/`secrets.*` trocados por `inputs.*`/`secrets.*`. Os jobs `rc`, `deploy-test`, `final` e `cleanup` ganham `id`s de step `rc`, `deploy`, `final` e `cleanup` (a Fase 4 usa esses ids).
- Chamadores: os mesmos `on:` e inputs de hoje.
  - O `release.yml` declara `permissions` contents, pull-requests e issues write, e um job `release` com `uses: Kaina-Ribeiro/release-kit/.github/workflows/release.yml@v1`, passando cada `vars.X` e `secrets.X`.
  - O `pr-checks.yml` declara `permissions: contents: read`.
- `install.sh <target> [--force] [--kit-ref <ref>]`: o padrão é `v1`, e o script troca o `@v1` dos chamadores por `@<ref>`.

- [ ] **Step 1:** escrever os dois reutilizáveis e os dois chamadores.
- [ ] **Step 2:** a suíte continua verde (o `release.mjs` não muda).
- [ ] **Step 3:** com o "sim", fazer push do branch e instalar no sandbox com `install.sh … --kit-ref feat/reusable-workflows`. Rodar o ciclo:
  1. `cut-release` (dispatch).
  2. PR `feat/SBX-1-x` → release (checks + conventions verdes, rc tagueado).
  3. `deploy` com `dry_run`.
  4. PR release → main (`final`).
  - Anotar os links dos runs em Notas.
- [ ] **Step 4:** commit `feat: run the kit as reusable workflows pinned by version`.

### Task 3.3: rulesets, install, comando local e release do kit

**Status:** ⏳ pending

**Files:**
- Modify: `rulesets/default-branch.json` e `rulesets/version-lines.json`
- Modify: `install.sh`
- Create: `.github/workflows/kit-release.yml`
- Modify: `README.md` e `RELEASING.md` (Setup e "Before acting")

**Interfaces / decisões:**
- Os `required_status_checks.context` passam a ser os nomes anotados em **Spike F3 (5)**.
- O `install.sh` copia os chamadores, os rulesets e o `RELEASING.md`. Ele **não** copia mais o `release.mjs`, conforme o SPEC.
  - Para repos que já têm a instalação antiga, ele imprime os `gh api -X PUT repos/$repo/rulesets/<id>`, com a listagem de ids antes.
  - Ele também avisa para apagar `.github/scripts/release.mjs`.
- **Comando local** (substitui `node .github/scripts/release.mjs …` no RELEASING): um comando só, que sempre usa a versão fixada e fica dentro de `.git` (nunca entra em commit):
  `curl -fsSL https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/v1/release.mjs -o .git/release.mjs && node .git/release.mjs status`
- `kit-release.yml`:
  - `workflow_dispatch` com os inputs `version` (X.Y.Z) e `dry_run` (boolean).
  - Roda a suíte, recusa se a tag existe ou se a versão não é maior que a última, cria `vX.Y.Z` anotada e move `vX` (`git tag -f` + `git push -f origin refs/tags/vX`).
  - Com `dry_run`, só imprime.

- [ ] **Step 1:** escrever os arquivos acima.
- [ ] **Step 2:** `bash -n install.sh`. Instalar num repo git de rascunho local → lista os 5 arquivos e imprime os comandos, sem aplicar nada.
- [ ] **Step 3:** suíte verde. Commit `feat: release the kit as v1 and point the rulesets at the new check names`.
- [ ] **Step 4:** fechar a fase: PR, merge e, com o "sim", rodar `kit-release` com `version=1.0.0` → existem as tags `v1.0.0` e `v1`.

### Task 3.4: rollout nos 3 repos

**Status:** ⏳ pending. Cada push, PR e mudança de ruleset **precisa do "sim" do dono**. Os tickets são definidos com o dono.

Para cada repo (`npac-corporation-crm`, `totem-comanda`, `ari-ribeiro-karaoke`):

- [ ] **Step 1:** ver a linha aberta com o comando local (`… status`). Em 2026-11-05 eram `release/v0.7`, `release/v0.3` e `release/v0.1`.
- [ ] **Step 2:** branch `ci/<TICKET>-release-kit-v1` a partir da linha, `bash <kit>/install.sh <repo> --force` e `git rm .github/scripts/release.mjs`.
- [ ] **Step 3:** com o "sim": atualizar os rulesets `default-branch` e `version-lines` para os nomes novos (PUT). Depois push e PR para a linha. Os checks do próprio PR já saem com os nomes novos.
- [ ] **Step 4:** depois do merge, o push na linha deve gerar rc e um `deploy-test` verde. No ari, o log mostra `checking that it stays up` (o health gate que faltava). O `status` mostra o mesmo estado de antes.
- [ ] **Step 5:** anotar os links dos runs em Notas.

---

## Fase 4: issue quando a automação falha (branch `feat/failure-issues`)

### Task 4.1: comando `report` + mock do GitHub

**Status:** ⏳ pending

**Files:**
- Modify `release.mjs`: `catch` final, `cmdReport` novo, `COMMANDS`, cabeçalho
- Create `test/github-mock.mjs`
- Modify `test/fixtures.sh` (seção nova 16)

**Interfaces:**
- Em qualquer falha, o `release.mjs` grava `error=<mensagem numa linha só>` em `GITHUB_OUTPUT` antes de sair.
- `release.mjs report --job <rc|deploy-test|final|cleanup> --line <branch> --result <success|failure|skipped|cancelled> --run-url <url> [--error <texto>]`
  - Título: `Release automation failing: ${job} on ${line}`. Label: `release-kit`.
  - `failure`: se não existe issue aberta com esse título → cria (`opened issue #N`); se existe → comenta (`commented on issue #N`).
  - `success`: se existe → comenta `Fixed by ${runUrl}`, fecha e imprime `closed issue #N`; senão imprime `✓ no open issue for ${job} on ${line}`.
  - `skipped` e `cancelled`: nada.
  - Corpo (issue e comentário): link do run, linha, erro num bloco de código e o link `RELEASING.md#when-the-automation-refuses`.
  - Erro de API → `warn`, exit 0. Em dry-run: `would open issue "<título>"`.
- `test/github-mock.mjs <port>`: issues em memória.
  - Rotas: `GET /repos/:o/:r/issues?state=open&labels=release-kit`, `POST /repos/:o/:r/issues`, `POST /repos/:o/:r/issues/:n/comments` e `PATCH /repos/:o/:r/issues/:n`.
  - Exige `authorization: Bearer test-token`.

- [ ] **Step 1: teste (seção 16)**
```bash
echo; echo "=== 16. failures open one issue per job and line; a recovery closes it"
cd "$scratch/work"
GITHUB_OUTPUT="$scratch/out-err" expect fail rc --branch release/v0.2 --dry-run --no-fetch
check "error output" grep -q '^error=release/v0.2 already shipped' "$scratch/out-err"
node "$kit/test/github-mock.mjs" 47124 & ghmock=$!; sleep 1
export GITHUB_API_URL=http://127.0.0.1:47124 GH_TOKEN=test-token
expect_out ok "opened issue #1" report --job final --line release/v0.3 --result failure --run-url https://x/runs/1 --error "prod does not run v0.3.2-rc"
expect_out ok "commented on issue #1" report --job final --line release/v0.3 --result failure --run-url https://x/runs/2 --error "again"
expect_out ok "no open issue for rc on release/v0.3" report --job rc --line release/v0.3 --result success --run-url https://x/runs/3
expect_out ok "closed issue #1" report --job final --line release/v0.3 --result success --run-url https://x/runs/4
kill $ghmock; export GH_TOKEN=; unset GITHUB_API_URL
expect_out ok 'would open issue "Release automation failing: rc on hotfix/v0.2"' report --job rc --line hotfix/v0.2 --result failure --run-url u --dry-run
```
  O `cd` volta para a pasta da história principal, onde `release/v0.2` já foi entregue. O `trap` de saída também mata `$ghmock`.
- [ ] **Step 2:** rodar → MISS.
- [ ] **Step 3:** implementar.
- [ ] **Step 4:** rodar → exit 0. Commit `feat: open an issue when the automation fails and close it once it recovers`.

### Task 4.2: job `report` no workflow reutilizável

**Status:** ⏳ pending

**Files:** Modify `.github/workflows/release.yml` (reutilizável); `RELEASING.md` (seção nova "When the automation fails")

**Interfaces:**
- Os jobs `rc`, `deploy-test`, `final` e `cleanup` ganham `outputs.error: ${{ steps.<id>.outputs.error }}`, com os ids da Task 3.2. Se o Spike F3 (4) deu "não", o erro vem da API de logs: siga o que está em Notas.
- Job `report`:
  - `needs: [rc, deploy-test, final, cleanup]`, `if: always() && github.event_name != 'workflow_dispatch'`.
  - Faz checkout do repo e do kit, como os outros.
  - Env: `NEEDS=${{ toJSON(needs) }}`, `PR_HEAD`, `PR_BASE`, `REF_NAME` e `RUN_URL=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`.
  - O step percorre os jobs:
```bash
echo "$NEEDS" | jq -r 'to_entries[] | [.key, .value.result, (.value.outputs.error // "")] | @tsv' |
while IFS=$'\t' read -r job result error; do
  case $job in final) line=$PR_HEAD ;; cleanup) line=$PR_BASE ;; *) line=$REF_NAME ;; esac
  node .release-kit/release.mjs report --job "$job" --line "$line" --result "$result" --run-url "$RUN_URL" --error "$error"
done
```

- [ ] **Step 1:** escrever o job.
- [ ] **Step 2:** com o "sim", no sandbox (`--kit-ref feat/failure-issues`):
  1. `DEPLOY_TEST_APPS=demo/x/none` + um push numa linha → abre a issue `Release automation failing: deploy-test on release/v0.1`.
  2. Corrigir a variável e re-rodar → a issue fecha.
  - Anotar os links.
- [ ] **Step 3:** commit `feat: report automation failures from the release workflow`. Fechar a fase. Com o "sim", `kit-release` `1.1.0` faz os 3 repos receberem a mudança via `@v1`.

---

## Fechar cada fase

1. `bash test/fixtures.sh "" "$(mktemp -d)"` → `✓ all expectations met` (cole o fim da saída em Notas).
2. **Fases 1 e 3:** um revisor subagente novo, só leitura, com a instrução "skip style": revisa o diff do branch contra o SPEC e reporta em até 5 linhas. As Fases 2 e 4 não têm revisor.
3. Atualizar os Status e as Notas.
4. Antes do push: `git status`, `git branch -vv` e conferir o remoto. Pedir o "sim" do dono para o push e o PR.
5. Depois do merge: apagar o branch local e o remoto. A `master` local não fica à frente da origin.

## Notas

### Spike F3

| # | Pergunta | Resultado |
|:--|:--|:--|
| 1 | `github.event` é o do chamador? | ✅ sim: `push` (ref `main`), `pull_request` `opened` (merged `false`) e `closed` (merged `true`, head `feat/SBX-1-spike`), `workflow_dispatch` com `inputs.command=x`; `github.repository` e `event.repository` = sandbox |
| 2 | `vars` chega no workflow chamado? | ✅ sim: `vars.SPIKE_VAR=1` (passamos tudo explicitamente mesmo assim) |
| 3 | `job.workflow_sha` = commit do kit? | ✅ sim: `a206496` (topo de `spike/reusable`) nos 4 runs, e o checkout do kit nesse sha deu `HEAD=a206496`. ⚠️ `github.workflow_sha` é o do **chamador** (`76a7741`): use sempre `job.workflow_*` |
| 4 | O output de um step que falhou chega a um job dependente? | ✅ sim: `needs.run.outputs.error=boom`, `result=failure` |
| 5 | O nome do check do job chamador `checks` | ✅ `checks / run` e `checks / after` (`<job do chamador> / <job do kit>`), app 15368. No kit: `pr-checks / checks` e `pr-checks / conventions` |

Runs (sandbox `Kaina-Ribeiro/release-kit-sandbox`, privado, 2026-11-05): push
[42102105227](https://github.com/Kaina-Ribeiro/release-kit-sandbox/actions/runs/42102105227), PR aberto
[42102131557](https://github.com/Kaina-Ribeiro/release-kit-sandbox/actions/runs/42102131557), PR mergeado
[42102171618](https://github.com/Kaina-Ribeiro/release-kit-sandbox/actions/runs/42102171618), dispatch
[42102128633](https://github.com/Kaina-Ribeiro/release-kit-sandbox/actions/runs/42102128633). Decisão: (1) e (3) "sim" →
segue com workflows reutilizáveis; a Fase 4 lê o erro pelo output do step.

### Fase 1

Branch `fix/kit-guards`, 2026-11-05. Commits: `cde6ea8` (1.1), `421fbce` (1.2, B3), `f3f0705` (1.3, B5),
`55ecbe5` (1.4, B2), `56f63fd` (1.5, B1), `7e9e358` (1.6, B4), `2aaeb2b` (1.7, B6), `cb3a9bd` (README),
`ea8ee0a` (guarda contra push), `b82a802` (achados #2 e #3 do revisor), `47ff6af` (achado #1). Cada bug teve o teste em RED antes da correção.

Fim da saída de `bash test/fixtures.sh "" "$(mktemp -d)"`:

```

$ release.mjs final --head release/v0.1   [expect ok: "release v0.1.0 already exists"]
✓ v0.1.0 already on a26ca13df8c8
✓ release v0.1.0 already exists
✓ no open PRs from release/v0.1
(exit 0)

✓ all expectations met
(94 passos expect/expect_out + 21 check, exit 0)
```

Com o kit como fonte (`bash test/fixtures.sh . "$(mktemp -d)"`, default branch `fix/kit-guards`): exit 0, `✓ all expectations met`, 94 passos + 21 check, 0 MISS.

Surpresas e decisões:

- **B2, regra literal quebrava a seção 9.** Lá o merge da release no default branch vem antes do deploy prod
  (o conserto documentado de "final refused, prod does not run"). O commit de merge não é ancestral do rc, e
  a regra literal recusava. Agora também passa o rc cuja árvore é igual à do default branch (prod não perde
  nada). O `SPEC.md` (B2) diz isso.
- **Kit como fonte achou um bug do `fresh`:** com `src=.` relativo, cada seção nova clonava o work da seção
  anterior (o default virava `release/v0.1`). O `src` agora é absoluto.
- **Guarda contra push** (do commit `3d6edb6`, nunca mergeado): sai com 1 se o scratch não está vazio ou se um
  clone falha, confere que o único remoto é o bare do scratch e instala um `pre-push` que recusa outra URL.
  No Windows o git grava o caminho como `C:/…` e o bash vê `/tmp/…`, então a guarda usa o caminho do próprio
  git (`rev-parse --absolute-git-dir`); a comparação literal do `3d6edb6` falharia em toda execução. Seção 0
  prova a guarda (RED antes: com uma fonte inválida, o script fez push no `origin` do checkout).
- **Numeração:** a seção 0 (guarda), a 14b (B6 contra `test/github-mock.mjs`, `final` real) e a 14c (re-run
  cria a release que falta) não ocupam a 15
  e a 16, que a Fase 2 e a Fase 4 já usam.
- **B1:** um run a partir de uma linha sem rc falha com `<linha> has no rc to deploy` nos dois stages (só o
  `--branch` do job `rc` mantém o no-op no test).
- **B6:** quando a próxima release já contém o commit entregue, o comentário diz `its changes are already in
  <release>.`; quando o sync PR não pôde ser aberto, diz para abrir um (nunca aponta para um PR que não existe).
- O `README.md` ganhou a seção "Guards" (B1–B6), que o SPEC pede e o plano não listava.
- `fixtures.sh` também limpa `GITHUB_OUTPUT` e `GITHUB_REF_TYPE` (o CI do kit define os dois).

Revisor (subagente novo, só leitura, "skip style"): 5 achados.
- ✅ #2 corrigido: com o sync PR recusado (ex.: o repo não deixa o Actions criar PR), o comentário apontava
  "the sync PR" inexistente.
- ✅ #3 corrigido: nenhum `final` real exercitava POST /pulls e os comentários; agora a seção 14b faz isso.
- ✅ #1 corrigido em `47ff6af` (o dono pediu antes do push): se o POST /releases falhava depois do push da
  tag, o re-run parava em "already" (`rc`) ou "already on" (`final`) e a tag ficava sem release. Agora
  `ensureRelease` confere `GET /releases/tags/<tag>` nos dois re-runs e cria a release (ou prerelease) que
  falta, com as mesmas notas; um erro de API nessa conferência falha o job. Seção 14c prova (RED antes).
  O `api()` também passou a transformar uma falha de rede em `Failure` (mensagem, sem stack).
- Menores, adiados: o `afterShip` compara a próxima release com o commit de merge, não com o topo do default
  branch (interface do plano); o `ls-remote` do `deleteBranch` fica fora de um `try` (um re-run recupera).
- Fora do alcance do revisor: se o `GITHUB_TOKEN` dos 3 repos consegue abrir PR e comentar, e o
  `GITHUB_REF_TYPE=tag` num dispatch real a partir de uma tag. Conferir no primeiro uso.

### Fase 2

Branch `feat/hotfix-hf-tags`, 2026-11-05. Commit: `3e268b2` (2.1). RED antes da implementação: 42 MISS,
todos nos nomes `-hf` (seções 5, 6, 10, 12, 13, 14b e 15). Os passos legados da seção 15 já passavam
(são guardas, não RED).

Fim da saída de `bash test/fixtures.sh "" "$(mktemp -d)"`:

```
$ release.mjs deploy-check v0.1.2-hf --prod   [expect ok: "✓ v0.1.2-hf can go to prod (same code as v0.1.2-hf-rc)"]
✓ v0.1.2-hf can go to prod (same code as v0.1.2-hf-rc)
(exit 0)

✓ all expectations met
(107 passos expect/expect_out + 21 check, exit 0)
```

Com o kit como fonte (`bash test/fixtures.sh . "$(mktemp -d)"`, default branch `feat/hotfix-hf-tags`): exit 0,
`✓ all expectations met`, 107 passos + 21 check, 0 MISS.

Surpresas e decisões:

- **Fora da lista do plano, mas pedido pela fase:** as seções 12 (B2), 13 (B1) e 14b (B6) criavam à mão rcs e
  finais de hotfix com os nomes antigos. Agora usam `-hf-rc`/`-hf`, e ficaram fixadas as mensagens do B1
  (`hotfix/v0.1: v0.1.1-hf-rc` na lista de linhas abertas), do B2 (`prod v0.1.1-hf`) e do B6 (comentário
  `shipped as v0.1.1-hf`). A 14b também prova que o final `-hf` real vira release e não prerelease.
- **Latest:** o mock do GitHub não registra `make_latest`. O kit manda `make_latest: 'true'` para todo release
  que não é prerelease, então o check `release v0.1.1-hf` (sem `(prerelease)`) cobre isso.
- **Seção 5, a mais:** o rc no commit do cut do hotfix (`no new code on hotfix/v0.2`), o comentário do B6 com
  `v0.2.3-hf` e o re-run do `final` depois da tag (`✓ v0.2.3-hf already on`). A seção 10 fixa
  `in prod: v0.2.3-hf`.
- **Seção 15, a mais:** o final de um rc legado `-rc.N` (`v0.1.0-rc.1` → `v0.1.0`), a lista de tags e a linha
  do hotfix no `status`, o rollback para um final legado (`deploy-check v0.1.0 --prod`), o `cut-hotfix` com
  rc legado (`next rc v0.1.2-hf-rc`) e, depois do final `-hf`, o `status` e o rollback para `v0.1.2-hf`.
- O `v1.0` manual segue ignorado também pelo aviso de tags manuais do `status`, que só olha tags de release.
  Já era assim.
- O `status` lista todos os finais de um X.Y na linha da release, se o branch dela ainda existe
  (`release/v0.1: shipped (v0.1.0, v0.1.2-hf)`). Comportamento de antes, agora com o nome novo.
- Workflows e rulesets: nenhum filtro de tag exclui `-hf` (`refs/tags/v*`). Nada mudou neles.
- ⚠️ **Checkout compartilhado:** às 16:20 outra sessão trocou o `HEAD` desta pasta para `master` (e apagou
  `fix/kit-guards`) enquanto esta fase tinha mudanças sem commit. Os três refs estavam no mesmo commit, então
  nada se perdeu. Voltei para `feat/hotfix-hf-tags` antes do commit.

### Fase 3

- O commit `4810e87` (branch `claude/fix-personal-rulesets-40ba86`, 2026-11-04, nunca mergeado) faz o
  `install.sh` tirar o bypass actor Integration 15368 nos repos de usuário, porque o GitHub responde HTTP 422
  ali. A Task 3.3 precisa incorporar isso quando mexer nos rulesets e no `install.sh`.

### Fase 4

- `test/github-mock.mjs` já existe (Fase 1, seções 14b e 14c: pulls, comentários em PR e releases, portas
  47125 e 47126).
  A Task 4.1 o estende com as rotas de issues em vez de criar outro.
