import { execSync } from 'child_process';
import path from 'path';

// --- Container runtime detection ---

export type ContainerRuntime = {
  name: 'container' | 'podman' | 'docker';
  bin: string;
  /** Extra args prepended to every `run` command */
  runArgs: string[];
  /** Command to check availability */
  checkCmd: string;
  /** Command to list running containers (returns JSON) */
  listCmd: string;
  /** Parse nanoclaw container names from list JSON */
  parseOrphans: (json: string) => string[];
};

const RUNTIMES: ContainerRuntime[] = [
  {
    name: 'container',
    bin: 'container',
    runArgs: [],
    checkCmd: 'container system start',
    listCmd: 'container ls --format json',
    parseOrphans: (json: string) => {
      const containers: { configuration?: { id?: string } }[] = JSON.parse(json || '[]');
      return containers
        .map((c) => c.configuration?.id || '')
        .filter((id) => id.startsWith('nanoclaw-'));
    },
  },
  {
    name: 'podman',
    bin: 'podman',
    runArgs: ['--userns=keep-id', '--security-opt', 'label=disable'],
    checkCmd: 'podman info',
    listCmd: 'podman ps --format json',
    parseOrphans: (json: string) => {
      const containers: { Names?: string[] }[] = JSON.parse(json || '[]');
      return containers
        .flatMap((c) => c.Names || [])
        .filter((n) => n.startsWith('nanoclaw-'));
    },
  },
  {
    name: 'docker',
    bin: 'docker',
    runArgs: [],
    checkCmd: 'docker info',
    listCmd: 'docker ps --format json',
    parseOrphans: (json: string) => {
      // docker ps --format json outputs one JSON object per line (not an array)
      const lines = json.trim().split('\n').filter(Boolean);
      const containers: { Names?: string }[] = lines.map((l) => JSON.parse(l));
      return containers
        .map((c) => c.Names || '')
        .filter((n) => n.startsWith('nanoclaw-'));
    },
  },
];

function detectContainerRuntime(): ContainerRuntime {
  for (const runtime of RUNTIMES) {
    try {
      execSync(`which ${runtime.bin}`, { stdio: 'pipe', timeout: 5000 });
      return runtime;
    } catch {
      // not available, try next
    }
  }
  throw new Error(
    'No container runtime found. Install one of: Apple Container (macOS), Podman, or Docker.',
  );
}

export const CONTAINER_RUNTIME = detectContainerRuntime();

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const DEPLOYMENT_NAME = process.env.DEPLOYMENT_NAME || 'default';
export const DEPLOYMENT_DIR = path.resolve(PROJECT_ROOT, 'deployment', DEPLOYMENT_NAME);
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
