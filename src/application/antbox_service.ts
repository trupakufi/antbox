import { Action } from "../domain/actions/action.ts";
import { Aspect } from "../domain/aspects/aspect.ts";
import { AuthContextProvider } from "../domain/auth/auth_provider.ts";
import { User } from "../domain/auth/user.ts";
import { AggregationFormulaError } from "../domain/nodes/aggregation_formula_error.ts";
import { FolderNode } from "../domain/nodes/folder_node.ts";
import { Node, Permission } from "../domain/nodes/node.ts";
import { NodeContentUpdatedEvent } from "../domain/nodes/node_content_updated_event.ts";
import { NodeCreatedEvent } from "../domain/nodes/node_created_event.ts";
import { NodeDeletedEvent } from "../domain/nodes/node_deleted_event.ts";
import { NodeFilter } from "../domain/nodes/node_filter.ts";
import { NodeNotFoundError } from "../domain/nodes/node_not_found_error.ts";
import { NodeFilterResult } from "../domain/nodes/node_repository.ts";
import { NodeUpdatedEvent } from "../domain/nodes/node_updated_event.ts";
import { SmartFolderNodeEvaluation } from "../domain/nodes/smart_folder_evaluation.ts";
import { SmartFolderNodeNotFoundError } from "../domain/nodes/smart_folder_node_not_found_error.ts";
import { AntboxError, BadRequestError, ForbiddenError } from "../shared/antbox_error.ts";
import { Either, left, right } from "../shared/either.ts";
import { ActionService } from "./action_service.ts";
import { AspectService } from "./aspect_service.ts";
import { AuthService } from "./auth_service.ts";
import { DomainEvents } from "./domain_events.ts";
import { ExtService } from "./ext_service.ts";
import { NodeService } from "./node_service.ts";
import { NodeServiceContext } from "./node_service_context.ts";

export class AntboxService {
	readonly nodeService: NodeService;
	readonly authService: AuthService;
	readonly aspectService: AspectService;
	readonly actionService: ActionService;
	readonly extService: ExtService;

	constructor(nodeCtx: NodeServiceContext) {
		this.nodeService = new NodeService(nodeCtx);
		this.authService = new AuthService(this.nodeService);
		this.aspectService = new AspectService(this.nodeService);
		this.actionService = new ActionService(this.nodeService, this);

		this.extService = new ExtService(this.nodeService);

		this.subscribeToDomainEvents();
	}

	async createFile(
		authCtx: AuthContextProvider,
		file: File,
		metadata: Partial<Node>,
	): Promise<Either<AntboxError, Node>> {
		if (ActionService.isActionsFolder(metadata.parent!)) {
			return this.actionService.createOrReplace(file, metadata);
		}

		if (AspectService.isAspectsFolder(metadata.parent!)) {
			return this.aspectService.createOrReplace(file, metadata);
		}

		if (ExtService.isExtensionsFolder(metadata.parent!)) {
			return this.extService.createOrReplace(file, metadata);
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			metadata.parent ?? Node.ROOT_FOLDER_UUID,
			"Write",
		);

		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const voidOrErr = await this.nodeService.createFile(file, metadata);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(
				new NodeCreatedEvent(authCtx.principal.email, voidOrErr.value),
			);
		}

		return voidOrErr;
	}

	async createMetanode(
		authCtx: AuthContextProvider,
		metadata: Partial<Node>,
	): Promise<Either<AntboxError, Node>> {
		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			metadata.parent ?? Node.ROOT_FOLDER_UUID,
			"Write",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		return this.nodeService.createMetanode(metadata).then((result) => {
			if (result.isRight()) {
				DomainEvents.notify(
					new NodeCreatedEvent(authCtx.principal.email, result.value),
				);
			}

			return result;
		});
	}

	async createFolder(
		authCtx: AuthContextProvider,
		metadata: Partial<Node>,
	): Promise<Either<AntboxError, FolderNode>> {
		if (AntboxService.isSystemFolder(metadata.parent!)) {
			return left(new BadRequestError("Cannot create folders in system folder"));
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			metadata.parent ?? Node.ROOT_FOLDER_UUID,
			"Write",
		);

		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const result = await this.nodeService.createFolder({
			...metadata,
			owner: authCtx.principal.email,
			group: authCtx.principal.group,
			permissions: {
				...parentOrErr.value.permissions,
			},
		});

		if (result.isRight()) {
			DomainEvents.notify(new NodeCreatedEvent(authCtx.principal.email, result.value));
		}

		return result;
	}

	async list(
		authCtx: AuthContextProvider,
		uuid = Node.ROOT_FOLDER_UUID,
	): Promise<Either<AntboxError, Node[]>> {
		const parentOrErr = await this.#getFolderWithPermission(authCtx, uuid, "Read");
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const listOrErr = await this.nodeService.list(uuid);
		if (listOrErr.isLeft()) {
			return left(listOrErr.value);
		}

		const nodes = listOrErr.value.filter(
			(n) => !n.isFolder() || this.#assertCanRead(authCtx, n).isRight(),
		);

		return right(nodes);
	}

	async #getFolderWithPermission(
		auth: AuthContextProvider,
		uuid = Node.ROOT_FOLDER_UUID,
		permission: Permission,
	): Promise<Either<AntboxError, FolderNode>> {
		const folderOrErr = await this.nodeService.get(uuid);
		if (folderOrErr.isLeft()) {
			return left(folderOrErr.value);
		}

		if (!folderOrErr.value.isFolder()) {
			return left(new BadRequestError("Is not a folder"));
		}

		const voidOrErr = this.#assertPermission(auth, folderOrErr.value, permission);
		if (voidOrErr.isLeft()) {
			return left(voidOrErr.value);
		}

		return right(folderOrErr.value);
	}

	#assertCanRead(
		authCtx: AuthContextProvider,
		folder: FolderNode,
	): Either<AntboxError, void> {
		return this.#assertPermission(authCtx, folder, "Read");
	}

	#assertCanWrite(
		authCtx: AuthContextProvider,
		parent: FolderNode,
	): Either<AntboxError, void> {
		return this.#assertPermission(authCtx, parent, "Write");
	}

	#assertPermission(
		authCtx: AuthContextProvider,
		node: Node,
		permission: Permission,
	): Either<AntboxError, void> {
		const principal = authCtx.principal;

		if (!node.isFolder()) {
			return right(undefined);
		}

		if (User.isAdmin(principal as User)) {
			return right(undefined);
		}

		if (node.isRootFolder() && permission === "Read") {
			return right(undefined);
		}

		if (node.isRootFolder() && !User.isAdmin(principal as User)) {
			return left(new ForbiddenError());
		}

		if (node.owner === authCtx.principal.email) {
			return right(undefined);
		}

		if (node.permissions.anonymous.includes(permission)) {
			return right(undefined);
		}

		if (
			principal.groups.includes(node.group) &&
			node.permissions.group.includes(permission)
		) {
			return right(undefined);
		}

		if (
			principal.email !== User.ANONYMOUS_USER_EMAIL &&
			node.permissions.authenticated.includes(permission)
		) {
			return right(undefined);
		}

		return left(new ForbiddenError());
	}

	async get(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<NodeNotFoundError, Node>> {
		const nodeOrErr = await this.nodeService.get(uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		if (nodeOrErr.value.isFolder()) {
			return this.#getFolder(authCtx, nodeOrErr.value);
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			nodeOrErr.value.parent,
			"Read",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		return right(nodeOrErr.value);
	}

	#getFolder(authCtx: AuthContextProvider, folder: FolderNode): Either<AntboxError, FolderNode> {
		const assertNodeOrErr = this.#assertCanRead(authCtx, folder);
		if (assertNodeOrErr.isLeft()) {
			return left(assertNodeOrErr.value);
		}

		return right(folder);
	}

	query(
		_authCtx: AuthContextProvider,
		filters: NodeFilter[],
		pageSize = 25,
		pageToken = 1,
	): Promise<Either<AntboxError, NodeFilterResult>> {
		return this.nodeService.query(filters, pageSize, pageToken);
	}

	async update(
		authCtx: AuthContextProvider,
		uuid: string,
		metadata: Partial<Node>,
		merge?: boolean,
	): Promise<Either<AntboxError, void>> {
		const nodeOrErr = await this.nodeService.get(uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		const node = nodeOrErr.value;
		if (node.isFolder()) {
			return this.updateFolder(authCtx, node, metadata as Partial<FolderNode>);
		}

		const parentOrErr = await this.#getFolderWithPermission(authCtx, node.parent, "Write");
		if (parentOrErr.isLeft()) {
			return left(new ForbiddenError());
		}

		if (metadata.parent) {
			const newParentOrErr = await this.#getFolderWithPermission(
				authCtx,
				metadata.parent,
				"Write",
			);
			if (newParentOrErr.isLeft()) {
				return left(new ForbiddenError());
			}
		}

		const voidOrErr = await this.nodeService.update(uuid, metadata, merge);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(
				new NodeUpdatedEvent(authCtx.principal.email, uuid, metadata),
			);
		}

		return voidOrErr;
	}

	async updateFolder(
		authCtx: AuthContextProvider,
		folder: FolderNode,
		metadata: Partial<FolderNode>,
	): Promise<Either<AntboxError, void>> {
		const assertNodeOrErr = this.#assertCanWrite(authCtx, folder);
		if (assertNodeOrErr.isLeft()) {
			return left(assertNodeOrErr.value);
		}

		if (metadata.parent) {
			const newParentOrErr = await this.#getFolderWithPermission(
				authCtx,
				metadata.parent,
				"Write",
			);
			if (newParentOrErr.isLeft()) {
				return left(new ForbiddenError());
			}
		}

		const voidOrErr = await this.nodeService.update(folder.uuid, metadata);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(
				new NodeUpdatedEvent(folder.owner, folder.uuid, metadata),
			);
		}

		return voidOrErr;
	}

	async export(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<NodeNotFoundError | ForbiddenError, File>> {
		const nodeOrErr = await this.nodeService.get(uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			nodeOrErr.value.parent,
			"Export",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		return this.nodeService.export(nodeOrErr.value.uuid);
	}

	async copy(
		authCtx: AuthContextProvider,
		uuid: string,
		parent: string,
	): Promise<Either<AntboxError, Node>> {
		const parentOrErr = await this.#getFolderWithPermission(authCtx, parent, "Write");
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const noderOrErr = await this.get(authCtx, uuid);
		if (noderOrErr.isLeft()) {
			return left(noderOrErr.value);
		}

		const voidOrErr = await this.nodeService.copy(uuid, parent);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(
				new NodeCreatedEvent(authCtx.principal.email, voidOrErr.value),
			);
		}

		return voidOrErr;
	}

	async duplicate(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, Node>> {
		const noderOrErr = await this.get(authCtx, uuid);
		if (noderOrErr.isLeft()) {
			return left(noderOrErr.value);
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			noderOrErr.value.parent,
			"Write",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		return this.nodeService.duplicate(uuid);
	}

	updateFile(
		_authCtx: AuthContextProvider,
		uuid: string,
		file: File,
	): Promise<Either<AntboxError, void>> {
		if (AntboxService.isSystemFolder(uuid)) {
			return Promise.resolve(
				left(new BadRequestError("Cannot update system folder")),
			);
		}

		return this.nodeService.updateFile(uuid, file).then((result) => {
			if (result.isRight()) {
				DomainEvents.notify(
					new NodeContentUpdatedEvent(_authCtx.principal.email, uuid),
				);
			}

			return result;
		});
	}

	async evaluate(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<
		Either<
			SmartFolderNodeNotFoundError | AggregationFormulaError,
			SmartFolderNodeEvaluation
		>
	> {
		const nodeOrErr = await this.get(authCtx, uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		return this.nodeService.evaluate(uuid);
	}

	async delete(
		authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, void>> {
		const nodeOrErr = await this.nodeService.get(uuid);
		if (nodeOrErr.isLeft()) {
			return left(nodeOrErr.value);
		}

		if (nodeOrErr.value.isFolder() && this.#assertCanWrite(authCtx, nodeOrErr.value).isLeft()) {
			return left(new ForbiddenError());
		}

		const parentOrErr = await this.#getFolderWithPermission(
			authCtx,
			nodeOrErr.value.parent,
			"Write",
		);
		if (parentOrErr.isLeft()) {
			return left(parentOrErr.value);
		}

		const voidOrErr = await this.nodeService.delete(uuid);
		if (voidOrErr.isRight()) {
			DomainEvents.notify(new NodeDeletedEvent(authCtx.principal.email, uuid));
		}

		return voidOrErr;
	}

	getAction(_authCtx: AuthContextProvider, uuid: string) {
		return this.actionService.get(uuid);
	}

	runAction(
		authCtx: AuthContextProvider,
		uuid: string,
		uuids: string[],
		params: Record<string, string>,
	) {
		return this.actionService.run(authCtx, uuid, uuids, params);
	}

	listActions(_authCtx: AuthContextProvider): Promise<Action[]> {
		return this.actionService.list().then((nodes) => nodes);
	}

	getAspect(
		_authCtx: AuthContextProvider,
		uuid: string,
	): Promise<Either<AntboxError, Aspect>> {
		return this.aspectService.get(uuid);
	}

	listAspects(_authCtx: AuthContextProvider): Promise<Aspect[]> {
		return this.aspectService.list().then((nodes) => nodes);
	}

	runExtension(
		_authCtx: AuthContextProvider,
		uuid: string,
		request: Request,
	): Promise<Either<Error, Response>> {
		return this.extService.run(uuid, request);
	}

	private subscribeToDomainEvents() {
		DomainEvents.subscribe(NodeCreatedEvent.EVENT_ID, {
			handle: (evt) => this.actionService.runOnCreateScritps(evt as NodeCreatedEvent),
		});
		DomainEvents.subscribe(NodeUpdatedEvent.EVENT_ID, {
			handle: (evt) => this.actionService.runOnUpdatedScritps(evt as NodeUpdatedEvent),
		});
		DomainEvents.subscribe(NodeCreatedEvent.EVENT_ID, {
			handle: (evt) =>
				this.actionService.runAutomaticActionsForCreates(
					evt as NodeCreatedEvent,
				),
		});
		DomainEvents.subscribe(NodeUpdatedEvent.EVENT_ID, {
			handle: (evt) =>
				this.actionService.runAutomaticActionsForUpdates(
					evt as NodeUpdatedEvent,
				),
		});
	}

	static isSystemFolder(uuid: string): boolean {
		return (
			uuid === Node.SYSTEM_FOLDER_UUID ||
			AspectService.isAspectsFolder(uuid) ||
			ActionService.isActionsFolder(uuid) ||
			ExtService.isExtensionsFolder(uuid)
		);
	}
}
