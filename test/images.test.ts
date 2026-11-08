import { describe, expect, test } from 'bun:test';
import {
  connectionString,
  databaseForImage,
  findDatabase,
} from '../src/data/images';

describe('database catalog', () => {
  test('finds engines by common names', () => {
    expect(findDatabase('postgresql')?.key).toBe('postgres');
    expect(findDatabase('pg')?.key).toBe('postgres');
    expect(findDatabase('MongoDB')?.key).toBe('mongo');
    expect(findDatabase('sqlite')).toBeUndefined();
    expect(databaseForImage('mysql:8.4')?.key).toBe('mysql');
    expect(databaseForImage('nginx')).toBeUndefined();
  });

  test('builds connection strings with escaped credentials', () => {
    const pg = findDatabase('postgres')!;
    expect(
      connectionString(pg, 'node1.example.com', 30001, {
        username: 'postgres',
        password: 'p@ss/word',
        db: 'app',
      }),
    ).toBe('postgresql://postgres:p%40ss%2Fword@node1.example.com:30001/app');
    const redis = findDatabase('redis')!;
    expect(connectionString(redis, 'h', 1, { password: 'x' })).toBe(
      'redis://:x@h:1',
    );
    expect(connectionString(redis, 'h', 1, {})).toBe('redis://h:1');
  });

  test('asks for TLS when the database offers it', () => {
    const pg = findDatabase('postgres')!;
    const creds = { username: 'postgres', password: 'pw', db: 'app' };
    expect(connectionString(pg, 'h', 1, { ...creds, tls: 'preferred' })).toBe(
      'postgresql://postgres:pw@h:1/app?sslmode=require',
    );
    expect(connectionString(pg, 'h', 1, { ...creds, tls: 'off' })).toBe(
      'postgresql://postgres:pw@h:1/app',
    );
    expect(
      connectionString(findDatabase('mysql')!, 'h', 1, {
        password: 'pw',
        tls: 'required',
      }),
    ).toBe('mysql://root:pw@h:1/?ssl-mode=REQUIRED');
    expect(
      connectionString(findDatabase('mongo')!, 'h', 1, {
        password: 'pw',
        tls: 'preferred',
      }),
    ).toBe('mongodb://root:pw@h:1/?tls=true');
    const redis = findDatabase('redis')!;
    expect(
      connectionString(redis, 'h', 1, { password: 'x', tls: 'required' }),
    ).toBe('rediss://:x@h:1');
    expect(connectionString(redis, 'h', 1, { password: 'x', tls: 'off' })).toBe(
      'redis://:x@h:1',
    );
  });
});
