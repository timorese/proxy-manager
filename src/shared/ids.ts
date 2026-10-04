export const newId = (): string => crypto.randomUUID().slice(0, 8);
export const newRev = (): string => crypto.randomUUID();
