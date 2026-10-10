import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Run test files in lexical order of their path (suites are numbered). */
export class NameSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    return files;
  }
}
