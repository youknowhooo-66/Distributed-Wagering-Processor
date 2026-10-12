import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT_DIR = process.cwd();
const DOCS_DIR = path.join(ROOT_DIR, 'docs');
const SUMMARY_FILE = path.join(DOCS_DIR, 'evidence', 'summary.json');

let hasErrors = false;

function error(msg: string) {
  console.error(`❌ ERRO: ${msg}`);
  hasErrors = true;
}

function success(msg: string) {
  console.log(`✅ OK: ${msg}`);
}

console.log('=== VERIFICANDO INTEGRIDADE DOS DOCUMENTOS (scripts/check-docs) ===');

// 1. Carrega contagem oficial de testes do summary.json
if (!fs.existsSync(SUMMARY_FILE)) {
  error(`Arquivo ${SUMMARY_FILE} não encontrado. Execute scripts/collect-evidence.ts primeiro.`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf-8'));
const officialTotalTests = summary.total.tests;
const officialPass = summary.total.pass;
const officialFail = summary.total.fail;
console.log(`Contagem oficial de testes (summary.json): ${officialTotalTests} testes (${officialPass} pass, ${officialFail} fail)`);

// 2. Coleta todos os arquivos Markdown na raiz e em docs/
function getMdFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist' && entry.name !== 'raw' && entry.name !== 'load-runs') {
        files.push(...getMdFiles(fullPath));
      }
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

const rootMdFiles = fs.readdirSync(ROOT_DIR).filter(f => f.endsWith('.md')).map(f => path.join(ROOT_DIR, f));
const docsMdFiles = getMdFiles(DOCS_DIR);
const allMdFiles = [...new Set([...rootMdFiles, ...docsMdFiles])];

console.log(`Verificando ${allMdFiles.length} arquivos Markdown...`);

// Termos proibidos
const forbiddenTerms = [
  { term: '/Users/', desc: 'Caminho absoluto local com /Users/' },
  // Home directory resolved at runtime: the user name itself is never committed, and a bare
  // user name (e.g. "runner" on CI) would match ordinary words
  { term: os.homedir(), desc: 'Diretório home local' },
  { term: 'file://', desc: 'URI de arquivo local file://' },
  { term: 'double-entry', desc: 'Termo incorreto para partidas dobradas (usar partidas simples / saldo snapshot)' },
  { term: 'isConsistent', desc: 'Propriedade antiga camelCase da reconciliação (o código usa consistent)' },
  { term: 'intransponível', desc: 'Linguagem promocional' },
  { term: '100% confiável', desc: 'Linguagem promocional' },
  { term: 'altíssimo', desc: 'Linguagem promocional' },
  { term: 'excelência', desc: 'Linguagem promocional' },
];

for (const filePath of allMdFiles) {
  const relPath = path.relative(ROOT_DIR, filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // a) Termos proibidos
  for (const { term, desc } of forbiddenTerms) {
    if (content.includes(term)) {
      error(`${relPath}: Contém termo proibido "${term}" (${desc})`);
    }
  }

  // b) "wallet_ledger" sem "_entries"
  // Procura por "wallet_ledger" não seguido por "_entries"
  const walletLedgerRegex = /\bwallet_ledger\b(?!_entries)/g;
  if (walletLedgerRegex.test(content)) {
    error(`${relPath}: Contém "wallet_ledger" sem "_entries" (o nome da tabela é wallet_ledger_entries)`);
  }

  // c) Links relativos quebrados [texto](rel/path)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const rawLink = match[2]!.trim();
    if (
      !rawLink.startsWith('http://') &&
      !rawLink.startsWith('https://') &&
      !rawLink.startsWith('#') &&
      !rawLink.startsWith('mailto:')
    ) {
      const cleanLink = rawLink.split('#')[0]; // remove fragment
      if (cleanLink) {
        const targetAbs = path.resolve(path.dirname(filePath), cleanLink);
        if (!fs.existsSync(targetAbs)) {
          error(`${relPath}: Link relativo quebrado para "${cleanLink}"`);
        }
      }
    }
  }

  // d) Referências arquivo:Lnn
  const lineRefRegex = /([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+):(?:L|line\s*)(\d+)/g;
  let lineMatch;
  while ((lineMatch = lineRefRegex.exec(content)) !== null) {
    const refFile = lineMatch[1]!;
    const lineNum = parseInt(lineMatch[2]!, 10);
    const targetFileAbs = path.resolve(ROOT_DIR, refFile);
    if (fs.existsSync(targetFileAbs) && fs.statSync(targetFileAbs).isFile()) {
      const targetContent = fs.readFileSync(targetFileAbs, 'utf-8');
      const totalTargetLines = targetContent.split('\n').length;
      if (lineNum > totalTargetLines) {
        error(`${relPath}: Referência de linha ${refFile}:L${lineNum} excede total de linhas (${totalTargetLines})`);
      }
    }
  }
}

if (hasErrors) {
  console.error('\n❌ check-docs FALHOU com erros acima.');
  process.exit(1);
} else {
  success('Todos os arquivos de documentação estão íntegros e em conformidade com as regras de auditoria.');
  process.exit(0);
}
