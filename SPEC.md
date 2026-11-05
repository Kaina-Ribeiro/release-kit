# SPEC: release-kit, correções, hotfix `-hf`, kit fixado por versão, alerta de falha

Status: **rascunho para revisão** · 2026-11-05 · aprovado em conversa: 1A, 2A, 3A

## Objetivo

Parar de levar bugs da automação para os projetos. Para isso: corrigir os 6 bugs achados (B1–B6),
criar a regra de tag de hotfix (`v1.29.8-hf-rc` → `v1.29.8-hf`), fazer todos os repos rodarem a
mesma versão do kit (B7) e fazer os testes do kit verificarem de verdade (B8).

## Decidido (não rediscutir)

- **1A.** Hotfix segue "um patch por rc", como a release: `v1.29.8-hf-rc`, `v1.29.9-hf-rc` → final `v1.29.9-hf`.
- **2A.** O sufixo é `-hf`, como pedido. Para o SemVer, `v1.29.8-hf` é uma pré-versão. O kit ordena
  as tags por conta própria, e ferramentas externas que ordenam por SemVer ficam fora do escopo.
- **3A.** Ordem: Fase 1 (testes + B1–B6) → Fase 2 (`-hf`) → Fase 3 (kit fixado + 3 repos) → Fase 4 (issue quando falha).
- O semantic-release **não** substitui o kit. Dele vêm só ideias: versão fixada, alerta de falha, regras de linha.
- Repos que usam o kit: `npac-corporation-crm`, `ari-ribeiro-karaoke`, `totem-comanda`.

## Fora do escopo

- Calcular a versão pelos commits (`feat` → minor). As linhas continuam cortadas por `cut-release`.
- Mudar "um patch por rc" nas releases.
- `release.mjs doctor` (checar a configuração antes de agir) e comentários "saiu na vX" nos PRs. São ideias do semantic-release, ficam para depois.
- Uma regra contra hotfix velho (ex.: `hotfix/v0.6` aberto depois que a `v0.7` foi entregue): é uma suspeita que não testei.

---

## Fase 1: testes que verificam + bugs B1–B6

### Testes (B8)

- Em `test/fixtures.sh`, **todo passo verifica**. Cada passo é `expect ok|fail <args>` ou o novo
  `expect_out ok|fail "<texto>" <args>`, que também exige o texto na saída. O `r` (só imprimir) deixa de existir.
- Cada bug ganha uma seção que reproduz o cenário. **O teste vem antes da correção e precisa falhar antes dela.**
- `<source-repo>` passa a ser opcional: sem ele, o script monta um repo de origem próprio (um commit em `main`).
- Kit ganha CI: `.github/workflows/test.yml` roda `bash test/fixtures.sh "" "$RUNNER_TEMP/fx"` em PR e
  em push para `master`. O `install.sh` não copia esse arquivo (ele copia de `workflows/`).

### B1: deploy com a tag vazia pega o rc da linha errada

- **Hoje:** disparar `deploy` a partir de `hotfix/vX.Y` com a tag vazia manda para prod o último rc da release aberta mais nova.
- **Novo:** sem tag nem `--branch`, o `release.mjs deploy` (test ou prod) decide pelo ref do run
  (`GITHUB_REF_TYPE`, `GITHUB_REF_NAME`). "Linha aberta" = um `release/*` existente ainda não
  entregue, ou um `hotfix/*` existente.
  1. Run a partir de uma **tag** → deploya essa tag.
  2. Run a partir de uma **linha** (`release/*`, `hotfix/*`) → o último rc dessa linha.
  3. Run a partir do **default branch** → o último rc da única linha aberta. Com mais de uma aberta,
     **recusa** e lista as opções:
     `2 lines are open (hotfix/v0.6: v0.6.4-rc, release/v0.7: v0.7.2-rc); pass the tag or run from the line's branch`.
- O input `tag` do `release.yml` passa a dizer: `Empty = last rc of the branch you run from (or the tag you run from)`.
- **Teste:** um hotfix e uma release abertos. Partindo do hotfix → o rc do hotfix. Partindo de uma tag → a tag. Partindo do `main` → falha com a lista.

### B2: prod aceita um rc que não contém o que já está em prod

- **Hoje:** `deploy-check --prod` aceita o último rc de uma linha aberta mesmo sem o hotfix que já foi
  para o `main`, e prod perde o hotfix.
- **Novo:** um rc só vai para prod se contém o default branch (`main` é ancestral do rc). O rollback
  para um final não muda. Mensagem:
  `v0.7.2-rc lacks what main has (main at abc123, prod v0.6.4): prod would lose it. Merge the open sync PR (or main) into release/v0.7, then deploy the new rc.`
- **Teste:** um hotfix entregue e uma release sem o sync → `fail`. Depois do merge do `main` na release e de um rc novo → `ok`.

### B3: run a partir de uma tag quebra no `git fetch`

- **Hoje:** o checkout do GitHub deixa a cópia local da tag diferente da do remoto, e o
  `git fetch --tags --prune` aborta com um stack do Node (run 41934012981 do npac).
- **Novo:** `git fetch origin --tags --prune --force`. O remoto é a verdade, e só a automação cria tags.
- **Novo:** um comando git que falha vira `git <args> failed: <mensagem do git>`, sem stack. O fetch perde o `--quiet` para o git dizer o motivo.
- **Teste:** com a tag local trocada por uma "leve", `status` → `ok`.

### B4: corrida no `cut-release` faz a linha antiga perder o rc

- **Hoje:** o `cut-release` roda logo depois de um merge na `release/v0.2`, antes do rc dela sair. A
  `v0.3` marca o commit primeiro, e a `v0.2` conclui "sem código novo" e fica sem rc.
- **Novo (a):** `cut-release` a partir de uma release aberta recusa enquanto o topo dela não tem uma tag de release:
  `release/v0.2's head abc123 has no rc yet (its Release run may still be running); wait for it, then cut again.`
  O corte a partir do default branch não muda.
- **Novo (b):** o `rc` só pula um commit que carrega um **final** ou um **rc de uma linha mais velha**.
  O rc de uma linha mais nova no mesmo commit não bloqueia.
- **Teste:** a corrida do repro → a `v0.2` ganha o rc dela. `cut-release` antes do rc → `fail`.

### B5: uma linha mais nova pode fazer PR numa mais velha

- **Hoje:** `release/v0.2 → hotfix/v0.1` passa no `conventions`.
- **Novo:** uma linha faz PR só para o default branch ou para uma linha **mais nova** (X.Y maior). Mensagem:
  `release/v0.2 can merge only into main or a newer line; hotfix/v0.1 is older.`
- **Teste:** `release/v0.2 → hotfix/v0.1` → `fail`; `hotfix/v0.1 → release/v0.2` → `ok`.

### B6: o `final` apaga o branch e o GitHub fecha o sync PR em silêncio

- **Hoje:** o `final` apaga a linha entregue, e o GitHub fecha qualquer PR aberto que sai dela.
- **Novo:** depois de criar a tag final, antes de apagar o branch:
  1. Se a primeira release aberta (o menor X.Y) não contém o default branch, abre o PR
     `chore(sync): merge main into release/vX.Y`, a não ser que já exista um aberto. É o PR que o
     `conventions` já exige antes do release day.
  2. Comenta em cada PR aberto que sai da linha entregue:
     `Closed because hotfix/v0.6 shipped as v0.6.4; its changes reach release/v0.7 through #N.`
     (`#N` = o PR do passo 1.)
  3. Apaga o branch, como hoje.
- ⚠️ **Regra nova, necessária para o passo 1:** o `conventions` passa a aceitar o default branch
  como head de um PR para uma linha, com qualquer título Conventional Commits (como os sync PRs).
  Hoje esse PR falha, e o npac precisou do branch de contorno `chore/NPAC-12-merge-main` (PR #19).
- **Teste:** `final --dry-run` com uma release aberta imprime `would open PR "chore(sync): merge main into release/v0.3"`.
  `conventions --head main --base release/v0.3` → `ok`.

### Fase 1 pronta quando

- `bash test/fixtures.sh "" <dir-vazio>` sai com 0, e cada seção B1–B6 tem passos `expect` que falhavam antes da correção.
- O CI do kit fica verde num PR.
- `RELEASING.md` e `README.md` descrevem o comportamento novo (B1, B2, B4a, B5, B6).

---

## Fase 2: tags de hotfix `-hf`

| Linha | rcs | final |
|:--|:--|:--|
| `release/v1.29` | `v1.29.0-rc`, `v1.29.1-rc`, … | `v1.29.7` |
| `hotfix/v1.29` | `v1.29.8-hf-rc`, `v1.29.9-hf-rc`, … | `v1.29.9-hf` |

Regras:

- **O patch não muda:** um por rc, contado sobre release e hotfix do mesmo X.Y. Depois de `v1.29.7`, o primeiro rc do hotfix é `v1.29.8-hf-rc`.
- **Uma regra só para o final:** é o nome do último rc sem o `-rc` (ou o `-rc.N` legado) do fim:
  `v1.29.9-hf-rc` → `v1.29.9-hf`, `v0.2.2-rc` → `v0.2.2`, `v0.3.0-rc.1` → `v0.3.0`.
- **`-hf` é final em tudo:** "o que está em prod" (`status`, `cut-hotfix`), `checkLine`, rollback no
  `deploy-check --prod` (exige o `-hf-rc` com o mesmo código) e GitHub release marcada como latest.
- **Ordem dentro do kit:** por X.Y.Z; no mesmo Z, o rc vem antes do final.
- **Legado:** `vX.Y.Z-rc.N` e as tags de hotfix sem `-hf` (npac `v0.6.1-rc`…`v0.6.3`) continuam
  sendo lidos e nunca são criados. Um hotfix em andamento quando o kit atualizar recebe `-hf-rc` a
  partir do próximo rc, e o final segue o nome do último rc.
- Os rulesets não mudam (`v*` já cobre as tags novas). As mensagens e o `RELEASING.md` listam as 4 formas.

### Fase 2 pronta quando

- A seção 5 (hotfix) do `fixtures.sh` cobre o ciclo inteiro: `cut-hotfix` → `v0.2.3-hf-rc` → final
  `v0.2.3-hf` → um segundo `cut-hotfix` sai de `v0.2.3-hf` → `deploy-check v0.2.3-hf --prod` → `ok`.
- As tags legadas continuam aparecendo no `status`, e tudo passa no CI do kit.

---

## Fase 3: kit fixado por versão (B7)

**Escolha: workflows reutilizáveis no kit, chamados de cada repo por um arquivo curto fixado em `@v1`.**

| Opção | Prós | Contras |
|:--|:--|:--|
| **Workflows reutilizáveis** ⭐ | Jobs, condições e script vêm todos do kit; nenhuma cópia diverge | Os nomes dos checks obrigatórios mudam (os rulesets são atualizados uma vez) |
| Action composta (só o script fixado) | Os nomes dos checks não mudam | O YAML dos workflows continua copiado e diverge (a Fase 4 já muda o YAML) |

Desenho:

- O kit ganha `.github/workflows/release.yml` e `.github/workflows/pr-checks.yml` com `on: workflow_call`.
- Cada repo fica com chamadores curtos (mesmos gatilhos e inputs de hoje) que fazem
  `uses: Kaina-Ribeiro/release-kit/.github/workflows/<arquivo>@v1`.
- O workflow do kit faz checkout do repo chamador e do próprio kit em `job.workflow_sha` (o
  GitHub expõe esse valor; conferido na documentação) e roda esse `release.mjs`.
- **Variáveis e segredos são passados explicitamente** pelo chamador (`with:` / `secrets:`). A
  documentação não garante que `vars` e `secrets: inherit` cheguem num repo pessoal.
- Permissões (`contents`, `pull-requests`, `issues: write`) são declaradas no chamador.
- **Versão do kit:** tags `v1.0.0`, `v1.0.1`… e uma tag móvel `v1`. Uma correção vira um `v1.x.y`
  novo e move o `v1`, e os repos recebem sem PR. Uma mudança que quebra vira `v2`, e cada repo
  escolhe quando trocar. O CI da Fase 1 é a proteção contra uma versão ruim chegar em todos de uma vez.
- **Release do kit:** um workflow `kit-release` (dispatch, input `version`) roda os testes, cria
  `vX.Y.Z` e move `vX`. É uma ação externa: só roda com o seu sim.
- O `install.sh` passa a instalar os chamadores + rulesets + `RELEASING.md` e continua sem aplicar nada sozinho.

Primeiro passo da fase (spike, código descartável): testar num repo de rascunho:

1. Que `github.event` dentro do workflow chamado é o do chamador (push, PR fechado, dispatch com inputs).
2. Os nomes exatos dos checks (`<job chamador> / <job chamado>`). Os rulesets são atualizados com esses nomes.
3. Que tags e branches criados lá dentro respeitam os rulesets como hoje.

Rollout, um PR por repo para a linha aberta (`ci/<TICKET>-release-kit-v1`), cada push/PR com o seu sim:

- `npac-corporation-crm`, `totem-comanda`, `ari-ribeiro-karaoke` (o ari ganha o health gate que falta hoje).
- A atualização dos rulesets (novos nomes de checks) é uma mudança de configuração: também precisa do seu sim.

### Fase 3 pronta quando

- Os 3 repos rodam o kit `@v1`: o próximo push numa linha gera rc e o deploy de teste fica verde.
- O `status` mostra o mesmo estado de antes.
- Os checks obrigatórios nos PRs aparecem com os novos nomes e bloqueiam como antes.

---

## Fase 4: issue quando a automação falha

- Um job `report` no fim do `release.yml` do kit (`needs:` todos, `if: always()`).
- **Só jobs automáticos:** `rc`, `deploy-test`, `final`, `cleanup`. `deploy` e `cut` são disparados à
  mão, e quem dispara já vê a falha. `conventions` falhando é retorno normal de PR.
- **Uma issue por job + linha**, título `Release automation failing: final on release/v0.3`, label
  `release-kit`. Corpo: link do run, branch/tag, a mensagem de erro do `release.mjs` e a seção do
  `RELEASING.md` "When the automation refuses" que se aplica.
  A falha seguinte do mesmo par **atualiza** a mesma issue (comentário), sem abrir outra.
- O próximo sucesso do **mesmo** job + linha comenta `Fixed by <run>` e fecha a issue. Sucesso em outra linha não fecha.
- Para isso o `release.mjs` grava o erro como output do step antes de sair. O spike da fase confirma
  que o output de um step que falhou chega ao job `report`.
- Com `--dry-run`, imprime `would open issue "…"`.

### Fase 4 pronta quando

- No `fixtures.sh`: uma falha → `would open issue`; a mesma falha de novo → `would comment on issue`; o sucesso → `would close issue`.
- Num repo de rascunho: uma falha real abre a issue e o sucesso seguinte fecha.

---

## Arquivos por fase

| Fase | Arquivos |
|:--|:--|
| 1 | `release.mjs`, `test/fixtures.sh`, `.github/workflows/test.yml` (novo), `RELEASING.md`, `README.md` |
| 2 | `release.mjs`, `test/fixtures.sh`, `RELEASING.md` |
| 3 | `.github/workflows/release.yml` + `pr-checks.yml` (reutilizáveis, novos), `.github/workflows/kit-release.yml` (novo), `workflows/*.yml` (viram chamadores), `rulesets/*.json`, `install.sh`, docs |
| 4 | `.github/workflows/release.yml`, `release.mjs`, `test/fixtures.sh`, `RELEASING.md` |

## Riscos e o que ainda está em aberto

- ⚠️ **Fase 3:** se o spike mostrar que `github.event` não é o do chamador, a escolha cai para a action
  composta (tabela acima), e eu volto com a mudança antes de seguir.
- ⚠️ **Fase 3:** a tag móvel `v1` leva um kit com bug para os 3 repos de uma vez. A proteção é o CI
  da Fase 1. O plano B é fixar `@v1.x.y` e subir a versão por PR.
- ⚠️ **B6:** depois de cada entrega abre um PR `merge main into …`, quando há release aberta. É o
  passo que hoje você faz à mão (PR #19 do npac).
- Os tickets (`NPAC-`, `ARI-`, `COM-`) dos PRs de rollout são definidos na Fase 3.
