export interface ImageEntry {
  key: string;
  name: string;
  image: string;
  description: string;
  env?: Record<string, string>;
  size?: { cpu: number; mem: number; disk: number };
}

export interface DatabaseEntry extends ImageEntry {
  engine: 'postgres' | 'mysql' | 'mongo' | 'redis';
  scheme: string;
  defaultPort: number;
}

export const DATABASES: DatabaseEntry[] = [
  {
    key: 'postgres',
    name: 'PostgreSQL',
    image: 'postgres:18',
    description: 'Relational database',
    engine: 'postgres',
    scheme: 'postgresql',
    defaultPort: 5432,
    size: { cpu: 100, mem: 1024, disk: 10 },
  },
  {
    key: 'mysql',
    name: 'MySQL',
    image: 'mysql:8.4',
    description: 'Relational database',
    engine: 'mysql',
    scheme: 'mysql',
    defaultPort: 3306,
    size: { cpu: 100, mem: 1024, disk: 10 },
  },
  {
    key: 'mongo',
    name: 'MongoDB',
    image: 'mongo:8',
    description: 'Document database',
    engine: 'mongo',
    scheme: 'mongodb',
    defaultPort: 27017,
    size: { cpu: 100, mem: 1024, disk: 10 },
  },
  {
    key: 'redis',
    name: 'Redis',
    image: 'redis:8',
    description: 'In-memory cache and key-value store',
    engine: 'redis',
    scheme: 'redis',
    defaultPort: 6379,
    size: { cpu: 50, mem: 512, disk: 5 },
  },
];

export const POPULAR_IMAGES: ImageEntry[] = [
  {
    key: 'nginx',
    name: 'Nginx',
    image: 'nginx:stable-alpine',
    description: 'Web server and reverse proxy',
    size: { cpu: 50, mem: 512, disk: 5 },
  },
  {
    key: 'uptime-kuma',
    name: 'Uptime Kuma',
    image: 'louislam/uptime-kuma:1',
    description: 'Uptime monitoring dashboard',
    size: { cpu: 50, mem: 512, disk: 5 },
  },
  {
    key: 'n8n',
    name: 'n8n',
    image: 'n8nio/n8n:latest',
    description: 'Workflow automation',
    size: { cpu: 100, mem: 1024, disk: 10 },
  },
  {
    key: 'ghost',
    name: 'Ghost',
    image: 'ghost:5-alpine',
    description: 'Blog and newsletter platform',
    env: { NODE_ENV: 'development' },
    size: { cpu: 100, mem: 1024, disk: 10 },
  },
  {
    key: 'wordpress',
    name: 'WordPress',
    image: 'wordpress:latest',
    description: 'Website and blog (needs a MySQL database)',
    size: { cpu: 100, mem: 1024, disk: 10 },
  },
  {
    key: 'grafana',
    name: 'Grafana',
    image: 'grafana/grafana-oss:latest',
    description: 'Dashboards and observability',
    size: { cpu: 100, mem: 1024, disk: 10 },
  },
  {
    key: 'gitea',
    name: 'Gitea',
    image: 'gitea/gitea:latest',
    description: 'Self-hosted Git service',
    size: { cpu: 100, mem: 1024, disk: 20 },
  },
  {
    key: 'vaultwarden',
    name: 'Vaultwarden',
    image: 'vaultwarden/server:latest',
    description: 'Password manager (Bitwarden compatible)',
    size: { cpu: 50, mem: 512, disk: 5 },
  },
  {
    key: 'rabbitmq',
    name: 'RabbitMQ',
    image: 'rabbitmq:4-management',
    description: 'Message broker',
    size: { cpu: 100, mem: 1024, disk: 10 },
  },
  {
    key: 'mosquitto',
    name: 'Mosquitto',
    image: 'eclipse-mosquitto:2',
    description: 'MQTT broker',
    size: { cpu: 50, mem: 512, disk: 5 },
  },
];

export function findDatabase(ref: string): DatabaseEntry | undefined {
  const r = ref.toLowerCase().replace(/[^a-z]/g, '');
  return DATABASES.find(
    (d) =>
      d.key === r ||
      d.name.toLowerCase() === r ||
      (r === 'postgresql' && d.key === 'postgres') ||
      (r === 'pg' && d.key === 'postgres') ||
      (r === 'mongodb' && d.key === 'mongo'),
  );
}

export function databaseForImage(image: string): DatabaseEntry | undefined {
  const n = image.toLowerCase();
  return DATABASES.find((d) => n.includes(d.engine));
}

export function connectionString(
  db: DatabaseEntry,
  host: string,
  port: number,
  creds: Record<string, any>,
): string {
  const user =
    creds.username ??
    creds.user ??
    (db.engine === 'mysql'
      ? 'root'
      : db.engine === 'mongo'
        ? 'root'
        : db.engine === 'postgres'
          ? 'postgres'
          : '');
  const pass = creds.password ?? '';
  const auth = pass
    ? `${encodeURIComponent(String(user))}:${encodeURIComponent(String(pass))}@`
    : user && db.engine !== 'redis'
      ? `${encodeURIComponent(String(user))}@`
      : '';
  const redisAuth =
    db.engine === 'redis' && pass
      ? `:${encodeURIComponent(String(pass))}@`
      : '';
  const name =
    creds.db ?? creds.database ?? (db.engine === 'postgres' ? 'postgres' : '');
  const path = db.engine === 'redis' ? '' : name ? `/${name}` : '';
  return `${db.scheme}://${db.engine === 'redis' ? redisAuth : auth}${host}:${port}${path}`;
}
