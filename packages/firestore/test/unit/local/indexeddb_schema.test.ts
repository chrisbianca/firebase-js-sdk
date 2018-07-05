/**
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect } from 'chai';
import { IndexedDbPersistence } from '../../../src/local/indexeddb_persistence';
import {
  createOrUpgradeDb,
  DbMutationBatch,
  DbMutationBatchKey,
  DbTarget,
  DbTargetGlobal,
  DbTargetGlobalKey,
  V1_STORES,
  V2_STORES,
  V3_STORES
} from '../../../src/local/indexeddb_schema';
import { SimpleDb, SimpleDbTransaction } from '../../../src/local/simple_db';
import { PersistencePromise } from '../../../src/local/persistence_promise';
import { ClientId } from '../../../src/local/shared_client_state';
import { DatabaseId } from '../../../src/core/database_info';
import { JsonProtoSerializer } from '../../../src/remote/serializer';
import { PlatformSupport } from '../../../src/platform/platform';
import { AsyncQueue } from '../../../src/util/async_queue';

const INDEXEDDB_TEST_DATABASE_PREFIX = 'schemaTest/';
const INDEXEDDB_TEST_DATABASE =
  INDEXEDDB_TEST_DATABASE_PREFIX + IndexedDbPersistence.MAIN_DATABASE;

function withDb(
  schemaVersion,
  fn: (db: IDBDatabase) => Promise<void>
): Promise<void> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(
      INDEXEDDB_TEST_DATABASE,
      schemaVersion
    );
    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;
      createOrUpgradeDb(
        db,
        new SimpleDbTransaction(request.transaction),
        event.oldVersion,
        schemaVersion
      );
    };
    request.onsuccess = (event: Event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };
    request.onerror = (event: ErrorEvent) => {
      reject((event.target as IDBOpenDBRequest).error);
    };
  })
    .then(db => fn(db).then(() => db))
    .then(db => {
      db.close();
    });
}

async function withPersistence(
  clientId: ClientId,
  fn: (persistence: IndexedDbPersistence) => Promise<void>
): Promise<void> {
  const partition = new DatabaseId('project');
  const serializer = new JsonProtoSerializer(partition, {
    useProto3Json: true
  });
  const persistence = new IndexedDbPersistence(
    INDEXEDDB_TEST_DATABASE_PREFIX,
    clientId,
    PlatformSupport.getPlatform(),
    new AsyncQueue(),
    serializer
  );

  await fn(persistence);
  await persistence.shutdown();
}

function getAllObjectStores(db: IDBDatabase): string[] {
  const objectStores: string[] = [];
  for (let i = 0; i < db.objectStoreNames.length; ++i) {
    objectStores.push(db.objectStoreNames.item(i));
  }
  objectStores.sort();
  return objectStores;
}

function getTargetCount(db: IDBDatabase): Promise<number> {
  const sdb = new SimpleDb(db);
  return sdb
    .runTransaction('readonly', [DbTargetGlobal.store], txn =>
      txn
        .store<DbTargetGlobalKey, DbTargetGlobal>(DbTargetGlobal.store)
        .get(DbTargetGlobal.key)
    )
    .then(metadata => metadata.targetCount);
}

describe('IndexedDbSchema: createOrUpgradeDb', () => {
  if (!IndexedDbPersistence.isAvailable()) {
    console.warn('No IndexedDB. Skipping createOrUpgradeDb() tests.');
    return;
  }

  beforeEach(() => SimpleDb.delete(INDEXEDDB_TEST_DATABASE));

  after(() => SimpleDb.delete(INDEXEDDB_TEST_DATABASE));

  it('can install schema version 1', () => {
    return withDb(1, async db => {
      expect(db.version).to.equal(1);
      // Version 1 adds all of the stores so far.
      expect(getAllObjectStores(db)).to.have.members(V1_STORES);
    });
  });

  it('can install schema version 2', () => {
    return withDb(2, db => {
      expect(db.version).to.equal(2);
      // We should have all of the stores, we should have the target global row
      // and we should not have any targets counted, because there are none.
      expect(getAllObjectStores(db)).to.have.members(V2_STORES);
      // Check the target count. We haven't added any targets, so we expect 0.
      return getTargetCount(db).then(targetCount => {
        expect(targetCount).to.equal(0);
      });
    });
  });

  it('can install schema version 3', () => {
    return withDb(3, async db => {
      expect(db.version).to.be.equal(3);
      expect(getAllObjectStores(db)).to.have.members(V3_STORES);
    });
  });

  it('can upgrade from schema version 1 to 2', () => {
    const expectedTargetCount = 5;
    return withDb(1, db => {
      const sdb = new SimpleDb(db);
      // Now that we have all of the stores, add some targets so the next
      // migration can count them.
      return sdb.runTransaction('readwrite', [DbTarget.store], txn => {
        const store = txn.store(DbTarget.store);
        let p = PersistencePromise.resolve();
        for (let i = 0; i < expectedTargetCount; i++) {
          p = p.next(() => store.put({ targetId: i }));
        }
        return p;
      });
    }).then(() =>
      withDb(2, db => {
        expect(db.version).to.equal(2);
        expect(getAllObjectStores(db)).to.have.members(V2_STORES);
        return getTargetCount(db).then(targetCount => {
          expect(targetCount).to.equal(expectedTargetCount);
        });
      })
    );
  });

  it('can upgrade from schema version 2 to 3', () => {
    const testWrite = { delete: 'foo' };
    const testMutations = [
      {
        userId: 'foo',
        batchId: 0,
        localWriteTime: 1337,
        mutations: []
      },
      {
        userId: 'foo',
        batchId: 1,
        localWriteTime: 1337,
        mutations: [testWrite]
      },
      {
        userId: 'foo',
        batchId: 42,
        localWriteTime: 1337,
        mutations: [testWrite, testWrite]
      }
    ];

    return withDb(2, db => {
      const sdb = new SimpleDb(db);
      return sdb.runTransaction('readwrite', [DbMutationBatch.store], txn => {
        const store = txn.store(DbMutationBatch.store);
        let p = PersistencePromise.resolve();
        for (const testMutation of testMutations) {
          p = p.next(() => store.put(testMutation));
        }
        return p;
      });
    }).then(() =>
      withDb(3, db => {
        expect(db.version).to.be.equal(3);
        expect(getAllObjectStores(db)).to.have.members(V3_STORES);

        const sdb = new SimpleDb(db);
        return sdb.runTransaction('readwrite', [DbMutationBatch.store], txn => {
          const store = txn.store<DbMutationBatchKey, DbMutationBatch>(
            DbMutationBatch.store
          );
          let p = PersistencePromise.resolve();
          for (const testMutation of testMutations) {
            p = p.next(() =>
              store.get(testMutation.batchId).next(mutationBatch => {
                expect(mutationBatch).to.deep.equal(testMutation);
              })
            );
          }
          p = p.next(() => {
            store
              .add({} as any) // tslint:disable-line:no-any
              .next(batchId => {
                expect(batchId).to.equal(43);
              });
          });
          return p;
        });
      })
    );
  });
});

describe('IndexedDb: allowTabSynchronization', () => {
  if (!IndexedDbPersistence.isAvailable()) {
    console.warn('No IndexedDB. Skipping allowTabSynchronization tests.');
    return;
  }

  beforeEach(() => SimpleDb.delete(INDEXEDDB_TEST_DATABASE));

  after(() => SimpleDb.delete(INDEXEDDB_TEST_DATABASE));

  it('rejects access when synchronization is disabled', () => {
    return withPersistence('clientA', async db1 => {
      await expect(db1.start(/*synchronizeTabs=*/ false)).to.eventually.be
        .fulfilled;
      await withPersistence('clientB', async db2 => {
        await expect(
          db2.start(/*synchronizeTabs=*/ false)
        ).to.eventually.be.rejectedWith(
          'Another tab has exclusive access to the persistence layer.'
        );
      });
    });
  });

  it('grants access when synchronization is enabled', async () => {
    return withPersistence('clientA', async db1 => {
      await expect(db1.start(/*synchronizeTabs=*/ true)).to.eventually.be
        .fulfilled;
      await withPersistence('clientB', async db2 => {
        await expect(db2.start(/*synchronizeTabs=*/ true)).to.eventually.be
          .fulfilled;
      });
    });
  });
});
