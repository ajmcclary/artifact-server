import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("Pass the SQLite database path as the first argument.");
}
const repository = new SqliteArtifactRepository(databasePath);
repository.close();
