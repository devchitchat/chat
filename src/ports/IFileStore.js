/**
 * IFileStore — port for file persistence.
 *
 * Implemented by:
 *   LocalFileStore    writes to data/uploads/{uploadId}/{storedName}
 *   InMemoryFileStore stores buffers in a Map (for tests)
 *
 * @interface
 */
export class IFileStore {
  /**
   * Persist a file stream.
   * @param {{ uploadId: string, storedName: string, stream: ReadableStream }} params
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async write({ uploadId, storedName, stream }) { throw new Error('Not implemented') }

  /**
   * Open a file for reading.
   * @param {{ uploadId: string, storedName: string }} params
   * @returns {Promise<ReadableStream>}
   */
  // eslint-disable-next-line no-unused-vars
  async read({ uploadId, storedName }) { throw new Error('Not implemented') }

  /**
   * Delete a stored file.
   * @param {{ uploadId: string, storedName: string }} params
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async delete({ uploadId, storedName }) { throw new Error('Not implemented') }
}
