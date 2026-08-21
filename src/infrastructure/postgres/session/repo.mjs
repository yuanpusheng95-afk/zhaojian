export function createPostgresSessionRepo({ pool }) {
  if (!pool) throw new TypeError('createPostgresSessionRepo requires a pg pool');
  return {
    async create() {
      throw new Error('not implemented');
    },
    async open() {
      throw new Error('not implemented');
    },
    async list() {
      throw new Error('not implemented');
    },
    async delete() {
      throw new Error('not implemented');
    },
    async fork() {
      throw new Error('not implemented');
    },
  };
}
