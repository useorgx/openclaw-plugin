import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const tokensPath = resolve(new URL('../dashboard/src/lib/tokens.ts', import.meta.url).pathname);
const defaultOut = resolve(new URL('../artifacts/orgx-design-tokens.json', import.meta.url).pathname);

const argvOut = process.argv[2] ? resolve(process.argv[2]) : defaultOut;

const tsSource = await readFile(tokensPath, 'utf8');
const compiled = ts.transpileModule(tsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    esModuleInterop: true,
  },
});

const encoded = Buffer.from(compiled.outputText, 'utf8').toString('base64');
const moduleUrl = `data:text/javascript;base64,${encoded}`;
const tokensModule = await import(moduleUrl);

const payload = {
  colors: tokensModule.colors,
  spacing: tokensModule.spacing,
  radius: tokensModule.radius,
  typography: tokensModule.typography,
  border: tokensModule.border,
  elevation: tokensModule.elevation,
  blur: tokensModule.blur,
  breakpoints: tokensModule.breakpoints,
  zIndex: tokensModule.zIndex,
  interaction: tokensModule.interaction,
  stateTones: tokensModule.stateTones,
  motion: tokensModule.motion,
  agentColors: tokensModule.agentColors,
  agentRoles: tokensModule.agentRoles,
  helpers: {
    getAgentColor: tokensModule.getAgentColor?.toString?.(),
    getAgentRole: tokensModule.getAgentRole?.toString?.(),
    getInitials: tokensModule.getInitials?.toString?.(),
    normalizeStatus: tokensModule.normalizeStatus?.toString?.(),
  },
  metadata: {
    generatedAt: new Date().toISOString(),
    source: tokensPath,
  },
};

await mkdir(dirname(argvOut), { recursive: true });
await writeFile(argvOut, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Exported tokens to ${argvOut}`);
