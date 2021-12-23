const SANDBOX_TIMEOUT = 60000; // 60 seconds

function now(): number {
    return (new Date()).getTime();
}

export class SandboxStore {
    sandboxes: Map<string, Sandbox>;

    constructor() {
        this.sandboxes = new Map();
    }

    getSandbox(creatorId: string, inputMessage, oldMessageId): string {
        this.cleanSandboxes();
        let box = this.sandboxes.get(creatorId);

        if (box) {
            let currentTime = now();
            if (currentTime - box.lastUpdated > SANDBOX_TIMEOUT) {
                this.sandboxes.set(creatorId, new Sandbox(inputMessage));
            } else {
                if (box.inputMessage.id !== oldMessageId) {
                    this.sandboxes.set(creatorId, new Sandbox(inputMessage));
                } else {
                    box.lastUpdated = now();
                    box.inputMessage = inputMessage;
                }
                return box.dockerContainerId;
            }
        } else {
            this.sandboxes.set(creatorId, new Sandbox(inputMessage));
        }

        return null;
    }

    isSandboxActive(sandboxId: string) {
        let box = this.sandboxes.get(sandboxId);
        return box && now() - box.lastUpdated < SANDBOX_TIMEOUT;
    }

    setContainerId(sandboxId: string, containerId: string) {
        let box = this.sandboxes.get(sandboxId);
        if (box) {
            box.lastUpdated = now();
            box.dockerContainerId = containerId;
        }
    }

    async sendSandboxOutput(sandboxId: string, message: string) {
        let box = this.sandboxes.get(sandboxId);
        if (!box) return;
        box.lastUpdated = now();

        if (box.outputMessage) {
            box.outputMessage.edit(message).catch(console.error);
        } else {
            box.outputMessage = await box.inputMessage.channel.send(message).catch(console.error);
        }
    }

    cleanSandboxes() {
        let currentTime = now();
        for (let id of this.sandboxes.keys()) {
            if (currentTime - this.sandboxes.get(id).lastUpdated > SANDBOX_TIMEOUT) {
                this.sandboxes.delete(id);
            }
        }
    }
}

class Sandbox {
    lastUpdated: number;
    inputMessage;
    outputMessage;
    dockerContainerId: string;

    constructor(inputMessage) {
        this.lastUpdated = now();
        this.inputMessage = inputMessage;
        this.outputMessage = null;
        this.dockerContainerId = null;
    }

    setContainerId(id: string): string {
        this.lastUpdated = now();
        let oldId = this.dockerContainerId;
        this.dockerContainerId = id;
        return oldId;
    }
}
