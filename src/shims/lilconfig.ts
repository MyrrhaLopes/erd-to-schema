// @mrleebo/prisma-ast procura um arquivo de config com lilconfig (Node fs).
// No navegador não há config: devolvemos sempre "nada encontrado".
export function lilconfigSync() {
  return { search: () => null, load: () => null };
}
export function lilconfig() {
  return { search: async () => null, load: async () => null };
}
