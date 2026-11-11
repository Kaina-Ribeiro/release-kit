// The command deploy adapter: the project's own script (DEPLOY_COMMAND, any language) does the
// deploy, run from the root of the project's checkout:
//   <DEPLOY_COMMAND> deploy  <stage> <target> <tag>   exit 0 = the target runs the tag and is up
//   <DEPLOY_COMMAND> current <stage> <target>         prints the tag or commit the target runs
// It also gets RELEASE_TAG, RELEASE_SHA (the tag's commit), RELEASE_STAGE and RELEASE_TARGET in
// its environment, besides the job's own (DEPLOY_URL, DEPLOY_TOKEN). An empty `current` means "I
// cannot tell": the final then warns and does not check that prod runs the rc.
// Loaded by release.mjs only for a deploy or the final's check that prod runs the rc.
import { execFileSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

export default function create({ dryRun, log, act, fail, commitOf, repoRoot }) {
  const command = () => (process.env.DEPLOY_COMMAND ?? '').trim();
  // RELEASE_DEPLOY_TIMEOUT_MS is for tests only.
  const timeoutMs = () => Number(process.env.RELEASE_DEPLOY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  // bash -c '<DEPLOY_COMMAND> "$@"' deploy-command <args…>: the command line is the project's, the
  // arguments are passed as they are. With `capture`, returns the command's standard output.
  function run(target, tag, stage, args, capture) {
    const shown = `${command()} ${args.join(' ')}`;
    try {
      return execFileSync('bash', ['-c', `${command()} "$@"`, 'deploy-command', ...args], {
        cwd: repoRoot(),
        env: { ...process.env, RELEASE_TAG: tag, RELEASE_SHA: commitOf(tag), RELEASE_STAGE: stage, RELEASE_TARGET: target },
        encoding: 'utf8',
        stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
        timeout: timeoutMs(),
      });
    } catch (err) {
      if (err.code === 'ETIMEDOUT') {
        fail(`${target}: the deploy command is still running after ${+(timeoutMs() / 60000).toFixed(2)} min; stopped waiting`);
      }
      if (typeof err.status === 'number') fail(`${target}: the deploy command exited with ${err.status} (${shown})`);
      fail(`${target}: could not run the deploy command (${shown}): ${err.message}`);
    }
  }

  return {
    name: 'command',
    missing: 'DEPLOY_COMMAND',
    configured: () => Boolean(command()),

    // Exit 0 means the target runs the tag and is up; anything else fails (and stops the deploy).
    async deploy(target, tag, stage) {
      act(`run: ${command()} deploy ${stage} ${target} ${tag}`);
      if (dryRun) return;
      run(target, tag, stage, ['deploy', stage, target, tag], false);
      log(`✓ ${target} runs ${tag}`);
    },

    // Read-only, so it runs under --dry-run too. The first non-empty line is what the target runs:
    // the tag's name, or its commit (the full SHA or a prefix of 7+ characters).
    async runs(target, tag, stage) {
      const out = run(target, tag, stage, ['current', stage, target], true);
      const current = out.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
      if (!current) return { runs: null, current: '' };
      const sha = commitOf(tag).toLowerCase();
      const runs = current === tag || (/^[0-9a-f]{7,40}$/i.test(current) && sha.startsWith(current.toLowerCase()));
      return { runs, current };
    },
  };
}
