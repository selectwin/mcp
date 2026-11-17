// Publica a imagem do mcp.selectwin.io DAQUI — o caminho que vem primeiro (dono, 17/11/2026: "Use o npm run image:push
// sempre! Não espere o Github CI"; "Mantém o CI, mas adianta com o image:push!").
//
//   npm run image:push   typecheck + testes, build e push de ghcr.io/selectwin/mcp:sha-<7> (+ latest) e o commit
//                        `deploy(image): …` que fixa o docker/stack/app.yml. Depois: git push origin HEAD:main — é o
//                        push que faz o Dokploy (Auto Deploy) subir a imagem.
//
// A tag é o sha do ÚLTIMO commit que mexeu no que entra na imagem (BUILD_PATHS, as mesmas paths do gatilho do
// .github/workflows/image.yml), não o do HEAD. É a mesma conta que o CI faz: quando o push chega lá com o pin já feito
// por cima do código, o CI acha a imagem no ghcr, não refaz o build, e o pin dele não muda nada.
//
// Recusa: código atrás do origin/main (a imagem não teria o que já está no ar, e o pin dela voltaria a produção para
// trás), mudança não commitada no que entra na imagem (a imagem não seria a de um commit) e branch que não seja a main
// (o HEAD destacado de uma worktree do origin/main vale).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'ghcr.io/selectwin/mcp';
const STACK = 'docker/stack/app.yml';
const BRANCH = 'main';
/** O que entra na imagem — as MESMAS paths do gatilho do .github/workflows/image.yml. */
const BUILD_PATHS = ['src', 'openapi.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsup.config.ts', 'Dockerfile', '.dockerignore'];
const PIN_RE = /ghcr\.io\/selectwin\/mcp:sha-[0-9a-f]{7}/;

function die(message, code = 1) {
  console.error(`image-publish: ${message}`);
  process.exit(code);
}

function run(cmd, args, { capture = true, allowFail = false } = {}) {
  // O `npm` do Windows é um .cmd, e o Node só o chama por um shell.
  const shell = process.platform === 'win32' && cmd === 'npm';
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true, shell });
  if (res.error) die(res.error.code === 'ENOENT' ? `${cmd} não está no PATH` : `${cmd} ${args[0]}: ${res.error.message}`, 2);
  if (res.status !== 0 && !allowFail) die(`${cmd} ${args.join(' ')} falhou (exit ${res.status})${capture && res.stderr ? `\n${res.stderr.trim()}` : ''}`);
  return res;
}

const git = (...args) => run('git', args).stdout.trim();

if ((process.argv[2] ?? 'push') !== 'push') die('uso: npm run image:push');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== BRANCH && branch !== 'HEAD') die(`a imagem que vai ao ar sai da ${BRANCH} (ou de uma worktree destacada do origin/${BRANCH}); aqui é a branch ${branch}`);

const dirty = git('status', '--porcelain', '--', ...BUILD_PATHS, STACK);
if (dirty) die(`há mudança não commitada no que entra na imagem — a imagem não seria a de um commit:\n${dirty}`);

const fetched = run('git', ['fetch', '--quiet', 'origin', BRANCH], { allowFail: true });
if (fetched.status !== 0) die(`git fetch origin ${BRANCH} falhou — sem ele não dá para saber se o HEAD tem tudo o que já está no ar:\n${fetched.stderr.trim()}`);
const ancestor = run('git', ['merge-base', '--is-ancestor', `origin/${BRANCH}`, 'HEAD'], { allowFail: true });
if (ancestor.status !== 0) {
  const behind = git('rev-list', '--count', `HEAD..origin/${BRANCH}`);
  die(`o HEAD está ${behind} commit(s) atrás do origin/${BRANCH}: a imagem não teria o que já está no ar, e o pin dela voltaria produção para trás.\n  atualize (git pull --rebase, ou git reset --keep origin/${BRANCH} se só houver pins velhos) e rode de novo.`);
}

const sha = git('log', '-1', '--format=%H', '--', ...BUILD_PATHS);
if (!sha) die('nenhum commit mexeu no que entra na imagem — nada a publicar');
const tag = `sha-${sha.slice(0, 7)}`;

console.log(`image-publish: ${IMAGE}:${tag} (o último commit do que entra na imagem: ${git('log', '-1', '--format=%h %s', sha)})`);
run('npm', ['run', 'typecheck'], { capture: false });
run('npm', ['test'], { capture: false });
run('docker', ['build', '--platform', 'linux/amd64', '-t', `${IMAGE}:${tag}`, '-t', `${IMAGE}:latest`, '.'], { capture: false });
run('docker', ['push', `${IMAGE}:${tag}`], { capture: false });
run('docker', ['push', `${IMAGE}:latest`], { capture: false });

const stackFile = join(ROOT, STACK);
const before = readFileSync(stackFile, 'utf8');
if (!PIN_RE.test(before)) die(`${STACK} não tem a linha \`${IMAGE}:sha-<7>\` para fixar`);
const after = before.replace(PIN_RE, `${IMAGE}:${tag}`);
if (after === before) {
  console.log(`\nimage-publish: ${STACK} já fixa ${tag} — nada a commitar.`);
} else {
  writeFileSync(stackFile, after);
  run('git', ['add', '--', STACK]);
  run('git', ['commit', '--quiet', '-m', `deploy(image): ${tag} — o stack do mcp.selectwin.io passa a puxar esta imagem`]);
  console.log(`\nimage-publish: ${STACK} → ${IMAGE}:${tag} (commit ${git('rev-parse', '--short=8', 'HEAD')})`);
}
console.log(`próximo: git push origin HEAD:${BRANCH} — o Dokploy sobe o stack no push.
  recusado? alguém publicou no meio: git reset --keep HEAD~1 (tira só este pin), git pull --rebase, npm run image:push de novo.`);
