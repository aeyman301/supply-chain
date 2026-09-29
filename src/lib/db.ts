import { useEffect, useMemo, useState } from "react";
import {
  ref,
  onValue,
  set,
  update,
  remove,
  push,
  get,
} from "firebase/database";
import { db } from "./firebase";

export function useDbList<T>(path: string) {
  const [data, setData] = useState<Record<string, T> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const r = ref(db, path);
    const unsub = onValue(
      r,
      (snap) => setData(snap.val() ?? {}),
      (e) => setError(e.message)
    );
    return () => unsub();
  }, [path]);

  const list = useMemo(() => {
    if (!data) return [];
    return Object.entries(data).map(([id, v]) => ({
      ...(v as object),
      id,
    })) as (T & { id: string })[];
  }, [data]);

  return { data, list, loading: data === null, error } as {
    data: Record<string, T> | null;
    list: (T & { id: string })[];
    loading: boolean;
    error: string | null;
  };
}

export async function dbSet(path: string, value: unknown) {
  await set(ref(db, path), value);
}

export async function dbUpdate(path: string, value: object) {
  await update(ref(db, path), value);
}

export async function dbRemove(path: string) {
  await remove(ref(db, path));
}

export async function dbPush<T>(path: string, value: T): Promise<string> {
  const r = await push(ref(db, path));
  await set(r, value);
  return r.key as string;
}

export async function dbPushMany<T>(path: string, values: T[]): Promise<void> {
  for (const v of values) {
    await push(ref(db, path), v);
  }
}

export async function dbGet(path: string) {
  const snap = await get(ref(db, path));
  return snap.val();
}

export function sanitizeKey(key: string) {
  return key.replace(/[.#$/[\]]/g, "_");
}
