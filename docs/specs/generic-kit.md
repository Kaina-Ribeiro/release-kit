# SPEC: release-kit genérico (deploy opcional e por adaptador)

Status: **rascunho para revisão** · 2026-11-11 · desenho aprovado em conversa

## Objetivo

Hoje o kit só sabe fazer deploy no Cubeship e só instala a partir de uma cópia local. Depois
desta mudança, qualquer projeto no GitHub instala o kit com um comando, usa só o versionamento
de tags se quiser, e liga o deploy pela plataforma que tiver.

Quem usa: os seus projetos e os de outra conta do GitHub (um amigo), chamando este mesmo repo.

## Decidido (não rediscutir)

- **Só tags é o padrão.** Deploy é um passo opcional, ligado na instalação.
- **Deploy por adaptador.** O kit mantém as regras; o adaptador executa. Dois adaptadores:
  `cubeship` (o código de hoje) e `command` (um script do projeto, em qualquer linguagem).
- **O botão de deploy vive num arquivo próprio** (`deploy.yml`), copiado só em projeto com deploy.
  O `release.yml` do projeto tem um formato só e não mostra `deploy`.
- **Instalação com um comando**, direto do GitHub. O modo com a pasta local continua.
- **Checks com comando próprio** (`CHECKS_COMMAND`) e **ticket opcional** (`TICKET_PATTERN=none`).
- **Compatível:** sai como `v1.2.0`. `npac-corporation-crm`, `totem-comanda` e
  `ari-ribeiro-karaoke` continuam funcionando em `@v1` sem nenhum PR.
- O modelo de linhas e tags (`release/vX.Y`, `-rc`, `-hf`) não muda.

## Fora do escopo

- Adaptadores prontos para outras plataformas (VPS por SSH, Vercel etc.).
- Apontar para uma cópia própria do kit (fork). Todos usam `Kaina-Ribeiro/release-kit`.
- Migrar os 3 repos para os nomes e arquivos novos. Eles migram quando forem reinstalados.
- Mais de um segredo por adaptador. Há um só: `DEPLOY_TOKEN`.
- Esconder do grafo do run os jobs pulados (já é assim hoje).

---

## 1. Deploy por adaptador

### O que fica no kit e o que vai para o adaptador

| Fica no kit (`release.mjs`) | Vai para o adaptador |
|:--|:--|
| Listas de alvos por stage, na ordem (`DEPLOY_TEST_APPS`, `DEPLOY_PROD_APPS`) | Como subir uma tag num alvo |
| `deploy-check`: o que pode ir para teste e para prod | Como saber o que um alvo roda |
| Parar no primeiro alvo que falha | Esperar o deploy e conferir que ficou de pé |
| `final` só cria a tag se prod roda o último rc | |
| `--dry-run`, resumo do job, issue de falha | |

```
deploy → deploy-check → para cada alvo, em ordem: adaptador.deploy → para no primeiro que falha
final  → para cada alvo de prod: adaptador.runs(rc)? → cria a tag final
```

Os nomes `DEPLOY_TEST_APPS` e `DEPLOY_PROD_APPS` não mudam. O valor passa a ser uma lista de
alvos que só o adaptador interpreta. Lista vazia = stage desligado, como hoje.

### Interface (dentro do kit)

Cada adaptador é um arquivo `adapters/<nome>.mjs` que exporta uma função `create(ctx)`. O `ctx`
traz o que o adaptador precisa do kit: `log`, `act`, `warn`, `fail`, `dryRun`, `commitOf`.

| Método | O que faz |
|:--|:--|
| `configured()` | Diz se as credenciais existem. Sem elas, um `--dry-run` só imprime o que faria |
| `deploy(target, tag, stage)` | Termina quando o alvo roda a tag e está de pé. Falha se não. Rodar de novo é seguro |
| `runs(target, tag, stage)` | Responde sim, não ou "não sei", e o que o alvo roda (para a mensagem de erro) |

O `release.mjs` carrega o adaptador só quando um comando faz deploy ou confere prod. Assim
`status`, `deploy-check` e `conventions` continuam funcionando com o `release.mjs` baixado
sozinho (o `curl` do `RELEASING.md`).

### Qual adaptador é usado

1. `DEPLOY_ADAPTER` definido: `cubeship` ou `command`. Outro valor falha e lista os válidos.
2. Vazio e `DEPLOY_COMMAND` definido: `command`.
3. Vazio, sem `DEPLOY_COMMAND`: `cubeship` (o comportamento de hoje).

Com alvos listados e nenhuma credencial: fora de `--dry-run`, falha dizendo o que definir
(`DEPLOY_COMMAND`, ou `DEPLOY_URL` + `DEPLOY_TOKEN`). Em `--dry-run`, só imprime.

### Adaptador `cubeship`

- O código de `release.mjs` linhas 392–572 vai para `adapters/cubeship.mjs`, **sem mudar
  comportamento**: aponta o app para a tag, dispara, espera, confere que o container fica de pé.
- Lê `DEPLOY_URL` e `DEPLOY_TOKEN`. Se faltarem, lê `CUBESHIP_URL` e `CUBESHIP_TOKEN`.
- `RELEASE_HEALTH_STABLE_S` e `RELEASE_HEALTH_WAIT_S` continuam valendo, só para ele.
- O alvo continua sendo `project/environment/app`.

### Adaptador `command`

O kit roda o comando de `DEPLOY_COMMAND` a partir da raiz do checkout do projeto:

```
<DEPLOY_COMMAND> deploy  <stage> <alvo> <tag>   # sair com 0 = no ar e de pé
<DEPLOY_COMMAND> current <stage> <alvo>         # imprime a tag ou o commit que o alvo roda
```

- Exemplo: `DEPLOY_COMMAND=./scripts/deploy.sh` e `DEPLOY_PROD_APPS=web`. Num deploy de prod o
  kit chama `./scripts/deploy.sh deploy prod web v0.2.1-rc`.
- O comando recebe também, no ambiente: `RELEASE_TAG`, `RELEASE_SHA`, `RELEASE_STAGE`,
  `RELEASE_TARGET`, `DEPLOY_URL`, `DEPLOY_TOKEN`.
- `deploy`: qualquer saída diferente de 0 falha o job e o próximo alvo não é deployado. Limite de
  45 minutos por alvo, igual ao do Cubeship.
- `current`: o kit compara a primeira linha impressa com o nome do rc e com o commit dele (SHA
  inteiro ou um prefixo de 7+ caracteres).
  - Igual: prod roda o rc.
  - Diferente: o `final` recusa com `prod does not run <rc>`, como hoje.
  - Vazio com saída 0: "não sei". O `final` avisa no log e no resumo do job, e **cria a tag**.
  - Saída diferente de 0: o `final` falha.
- Em `--dry-run`: `deploy` só imprime `would run: …`; `current` roda de verdade (é só leitura).

---

## 2. Workflows

### Reutilizáveis (no kit)

`.github/workflows/release.yml` ganha, todos opcionais:

| Entrada | Tipo | Vira a variável de ambiente |
|:--|:--|:--|
| `deploy_adapter` | input | `DEPLOY_ADAPTER` |
| `deploy_command` | input | `DEPLOY_COMMAND` |
| `deploy_url` | input | `DEPLOY_URL` |
| `deploy_token` | secret | `DEPLOY_TOKEN` |

`cubeship_url`, `cubeship_token`, `command`, `stage` e `tag` continuam, com o mesmo efeito. Os
chamadores antigos não mudam.

`.github/workflows/pr-checks.yml` ganha o input `checks_command`.

### Chamadores (copiados para o projeto)

| Arquivo no kit | Vai para | Quando | O que mostra em Actions |
|:--|:--|:--|:--|
| `workflows/release.yml` | `.github/workflows/release.yml` | Sempre | Release → `cut-release`, `cut-hotfix`, `version`, `dry_run` |
| `workflows/deploy.yml` (novo) | `.github/workflows/deploy.yml` | Só com deploy | Deploy → `stage`, `tag`, `dry_run` |
| `workflows/pr-checks.yml` | `.github/workflows/pr-checks.yml` | Sempre | (roda nos PRs) |

- O `release.yml` do projeto perde a opção `deploy` e os campos `stage` e `tag`. Ele continua
  passando as variáveis de deploy, porque o deploy automático de cada rc no stage de teste roda
  dentro dele. Sem variáveis, nada deploya.
- O `deploy.yml` do projeto chama o `release.yml@v1` do kit com `command: deploy`. É o mesmo
  mecanismo do botão de hoje, em outro arquivo.
- Os dois passam os nomes novos (`DEPLOY_ADAPTER`, `DEPLOY_COMMAND`, `DEPLOY_URL`,
  `DEPLOY_TOKEN`) e não citam o Cubeship.

---

## 3. Checks dos PRs

- O script do job `checks` sai do YAML e vai para `checks.sh`, no kit. O job faz checkout do kit
  (como o `conventions` já faz) e roda esse arquivo. Motivo: dá para testar.
- Com `CHECKS_COMMAND` definido (ex.: `make lint`), o job roda esse comando com
  `bash -euo pipefail -c` na raiz do projeto, e mais nada.
- Sem ele, vale o fluxo Node de hoje (`CHECKS_DIRS`, `CHECKS_SCRIPTS`), sem mudança.
- Os nomes dos checks obrigatórios não mudam (`pr-checks / checks`, `pr-checks / conventions`).

## 4. Ticket opcional

Com `TICKET_PATTERN=none`, para PRs de feature:

| | Com ticket (padrão, como hoje) | `TICKET_PATTERN=none` |
|:--|:--|:--|
| Branch | `feat/ABC-12-login` | `feat/login` |
| Título | `feat(ABC-12): add login` | `feat: add login` ou `feat(auth): add login` |

- O resumo continua começando em minúscula. Os tipos aceitos são os mesmos.
- A regra "o ticket do título é o da branch" deixa de valer nesse modo.
- As mensagens de erro mostram o exemplo do modo em uso.
- As outras regras (linhas de versão, sync PRs, reverts do GitHub) não mudam.

## 5. Instalação

```bash
curl -fsSL https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/v1/install.sh | bash -s -- .
```

Com deploy, acrescentar `--deploy` no fim.

- **De onde vêm os arquivos:** se o `install.sh` está dentro de uma cópia do kit, copia de lá
  (como hoje). Senão, baixa cada arquivo de `raw.githubusercontent.com` na versão de `--kit-ref`
  (padrão `v1`), a mesma para a qual os chamadores apontam.
- **Destino:** o primeiro argumento; sem ele, a pasta atual.
- **`--deploy`:** copia também o `deploy.yml`. O script liga esse modo sozinho quando o projeto
  já tem `.github/workflows/deploy.yml`, ou tem um `release.yml` do formato antigo (com `deploy`
  no menu). Assim um `--force` num repo com deploy nunca tira o botão.
- **O que imprime:** os comandos de configuração de hoje; `CHECKS_COMMAND` e `TICKET_PATTERN`
  nas variáveis opcionais; e, só no modo deploy, um bloco com as variáveis dos dois adaptadores.
- Continua sem fazer commit, push ou mudança de configuração.
- O caminho de upgrade da instalação antiga (`.github/scripts/release.mjs`) não muda.

## 6. Docs e licença

- `README.md`: instalar com um comando vira o passo 1. "Só tags" é o caminho principal; deploy
  é uma seção opcional com os dois adaptadores e o contrato do `command`.
- `README.md`, aviso de versão: em `@v1`, cada versão nova do kit roda no repo de quem instalou,
  com os tokens dele. Quem preferir fixa numa versão exata com `--kit-ref v1.2.0`.
- `RELEASING.md`: "Deploys" e "Setup" item 6 descrevem o deploy por adaptador. O botão passa a
  ser "Actions → Deploy". O Cubeship vira uma subseção.
- A mensagem `prod does not run <rc>` passa a dizer onde fica o botão nos dois formatos.
- Cabeçalho do `release.mjs` e comentários dos workflows: sem Cubeship fora do adaptador.
- `LICENSE` novo: MIT, `Copyright (c) 2026 Kaina Ribeiro`.

---

## Testes

`bash test/fixtures.sh "" <dir-vazio>` continua sendo o comando único.

- **Seções 0 a 16 passam sem edição.** As seções 8, 8b e 9 usam `CUBESHIP_URL` e
  `CUBESHIP_TOKEN`: são a prova de que os 3 repos não quebram.

Seções novas:

| # | Cenário | Espera |
|:--|:--|:--|
| 17 | Ciclo sem nenhuma variável de deploy | `deploy` → `nothing to deploy`; `final --dry-run` não confere prod |
| 18 | Cubeship com `DEPLOY_URL` e `DEPLOY_TOKEN` | Deploy ok. `DEPLOY_ADAPTER=foo` falha e lista os válidos |
| 19 | Adaptador `command`, com um script de teste | Deploy ok; alvo que falha impede o seguinte; `current` igual → `✓ prod runs`; diferente → `prod does not run`; vazio → aviso e segue; `--dry-run` → `would run` |
| 20 | Chamadores | O `release.yml` do projeto não tem `deploy`; o `deploy.yml` chama com `command: deploy`; tudo o que os chamadores passam existe como input no kit |
| 21 | `TICKET_PATTERN=none` | `feat/login` + `feat: add login` → ok; título com maiúscula → falha. Sem a variável, `feat/login` falha como hoje |
| 22 | `checks.sh` | `CHECKS_COMMAND` roda e a falha dele reprova; sem ele, o fluxo Node (`CHECKS_DRY_RUN`) imprime os mesmos passos de hoje |
| 23 | `install.sh` | Local: 6 arquivos, sem `deploy.yml`, e o `release.yml` sem `deploy` no menu. `--deploy`: 7 arquivos. Formato antigo detectado → 7 arquivos. Modo download (base trocada por `file://` no teste) → os mesmos arquivos do modo local |

Num repo de rascunho no GitHub (cada push e cada run com o seu sim):

- Instalar com o comando único a partir do branch da mudança (`--kit-ref <branch>`).
- Actions → Release mostra só `cut-release` e `cut-hotfix`; um ciclo rc → final sem deploy fica verde.
- Com `--deploy` e o adaptador `command`: Actions → Deploy roda o script do projeto.

## Arquivos

| Arquivo | Mudança |
|:--|:--|
| `release.mjs` | Deploy vira genérico: escolhe e carrega o adaptador; `conventions` aceita `none`; cabeçalho |
| `adapters/cubeship.mjs` | Novo: o código Cubeship movido |
| `adapters/command.mjs` | Novo |
| `checks.sh` | Novo: o script do job `checks` |
| `.github/workflows/release.yml` | 3 inputs e 1 secret novos |
| `.github/workflows/pr-checks.yml` | Input `checks_command`; roda `checks.sh` |
| `workflows/release.yml` | Sem `deploy`, `stage`, `tag`; nomes novos |
| `workflows/deploy.yml` | Novo |
| `workflows/pr-checks.yml` | Passa `CHECKS_COMMAND` |
| `install.sh` | Modo download, destino padrão, `--deploy`, detecção, texto impresso |
| `test/fixtures.sh`, `test/deploy-command.sh` (novo) | Seções 17 a 23 |
| `README.md`, `RELEASING.md`, `LICENSE` (novo) | Docs e licença |

## Pronto quando

- `bash test/fixtures.sh "" <dir-vazio>` termina com `✓ all expectations met`, com as seções
  0 a 16 sem edição.
- O CI do kit fica verde no PR.
- No repo de rascunho: instalação com um comando, ciclo só de tags verde, e um deploy pelo
  adaptador `command`.
- Depois da `v1.2.0`: o próximo rc de um dos 3 repos sai e o `deploy-test` dele fica verde, sem
  PR nesse repo.

## Riscos

- ⚠️ **A tag `v1` leva a mudança para os 3 repos de uma vez.** Mover o código do Cubeship não pode
  mudar comportamento. A proteção são as seções 8, 8b e 9 sem edição e o teste no rascunho antes
  da release. O plano B é o de sempre: fixar um repo em `@v1.1.0` por PR.
- ⚠️ **Outra conta usando `@v1`** roda cada versão nova do kit com os tokens dela. O aviso no
  `README.md` e o `--kit-ref` com versão exata cobrem isso.
- ⚠️ **`current` vazio pula a guarda de prod** no adaptador `command`. É uma escolha de quem
  escreve o script, e fica registrada no resumo do job.
- ⚠️ **Ligar o deploy depois exige um PR** com o `deploy.yml`.
- **Chamar um workflow reutilizável a partir de outra conta** não foi testado; a documentação do
  GitHub diz que funciona para repo público. O primeiro uso pelo amigo confirma.
- Cada push, PR, release do kit e mudança de configuração precisa do seu sim.
