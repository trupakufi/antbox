import { NodeFilter } from "/domain/nodes/node_filter.ts";
import {
  NodeFilterResult,
  NodeRepository,
} from "/domain/nodes/node_repository.ts";
import { Node } from "/domain/nodes/node.ts";
import { NodeNotFoundError } from "/domain/nodes/node_not_found_error.ts";
import { Either, left, right } from "/shared/either.ts";
import { getNodeFilterPredicate } from "/domain/nodes/node_filter_predicate.ts";

export class InMemoryNodeRepository implements NodeRepository {
  constructor(readonly db: Record<string, Partial<Node>> = {}) {}

  delete(uuid: string): Promise<Either<NodeNotFoundError, void>> {
    delete this.db[uuid];

    return Promise.resolve(right(undefined));
  }

  get records(): Node[] {
    return Object.values(this.db) as Node[];
  }

  get count(): number {
    return this.records.length;
  }

  add(node: Node): Promise<Either<NodeNotFoundError, void>> {
    this.db[node.uuid] = node;
    return Promise.resolve(right(undefined));
  }

  update(node: Node): Promise<Either<NodeNotFoundError, void>> {
    this.db[node.uuid] = node;
    return Promise.resolve(right(undefined));
  }

  getByFid(fid: string): Promise<Either<NodeNotFoundError, Node>> {
    const node = this.records.find((n) => n.fid === fid);

    if (!node) {
      return Promise.resolve(left(new NodeNotFoundError(Node.fidToUuid(fid))));
    }

    return Promise.resolve(right(node));
  }

  getById(uuid: string): Promise<Either<NodeNotFoundError, Node>> {
    const node = this.records.find((n) => n.uuid === uuid);

    if (!node) {
      return Promise.resolve(left(new NodeNotFoundError(uuid)));
    }

    return Promise.resolve(right(node));
  }

  filter(
    filters: NodeFilter[],
    pageSize: number,
    pageToken: number
  ): Promise<NodeFilterResult> {
    const firstIndex = (pageToken - 1) * pageSize;
    const lastIndex = firstIndex + pageSize;

    const filtered = this.records.filter(getNodeFilterPredicate(filters));

    const nodes = filtered.slice(firstIndex, lastIndex);

    const pageCount = Math.ceil(filtered.length / pageSize);

    return Promise.resolve({ nodes, pageCount, pageSize, pageToken });
  }
}
