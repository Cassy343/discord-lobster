import { Message, PartialMessage } from "discord.js";
import child_process from 'child_process';
import { promisify } from "util";
const exec = promisify(child_process.exec);

const SANDBOX_TIMEOUT = 60000; // 60 seconds
const CONTAINER_TIMOUT = 5000;

function now(): number {
    return (new Date()).getTime();
}

export class SandboxStore {
    sandboxes: { [key: string]: Sandbox };

    constructor() {
        this.sandboxes = {};
    }

    public async newSandbox(
        id: string,
        inputMessage: Message | PartialMessage,
        transferOutput: (oldMessage: Message | PartialMessage) => boolean
    ): Promise<string> {
        this.cleanSandboxes();

        let oldBox = this.sandboxes[id];
        let newBox = new Sandbox(inputMessage);
        await newBox.prepare();

        if (oldBox) {
            await oldBox.destroy(true);
            if (transferOutput(oldBox.inputMessage)) {
                newBox.outputMessage = oldBox.outputMessage;
            }
        }

        this.sandboxes[id] = newBox;
        return newBox.containerId;
    }

    public async sendOuput(id: string, containerId: string, output: string): Promise<void> {
        let box = this.getSandbox(id, containerId);
        if (!box) return new Promise(() => {});
        return box.sendOuput(output);
    }

    public copySourceFile(id: string, containerId: string, file: string): Promise<void> {
        let box = this.getSandbox(id, containerId);
        if (!box) return new Promise(() => {});
        return box.copySourceFile(file);
    }

    public async destroyContainer(id: string, containerId: string): Promise<void> {
        let box = this.getSandbox(id, containerId);
        if (box) return box.destroy(false);
        else return new Promise(() => {});
    }

    public startDestroyTimout(id: string, containerId: string) {
        let box = this.getSandbox(id, containerId);
        if (!box) return;

        setTimeout(() => {
            box?.destroy(true);
        }, CONTAINER_TIMOUT);
    }

    public execInContainer(id: string, containerId: string, command: string): Promise<{stdout: string, stderr: string} | null> {
        let box = this.getSandbox(id, containerId);
        if (!box) return new Promise(() => null);
        return box.execInContainer(command);
    }

    public activeContainerId(id: string, inputMessageId: string): string | null {
        let box = this.sandboxes[id];
        if (box && now() - box.lastUpdated < SANDBOX_TIMEOUT && box.inputMessage.id == inputMessageId) {
            box.lastUpdated = now();
            return box.containerId;
        } else {
            return null;
        }
    }

    private cleanSandboxes() {
        let currentTime = now();
        Object.keys(this.sandboxes).forEach(id => {
            if (currentTime - this.sandboxes[id].lastUpdated > SANDBOX_TIMEOUT) {
                delete this.sandboxes[id];
            }
        });
    }

    private getSandbox(id: string, containerId: string): Sandbox | null {
        let box = this.sandboxes[id];
        if (!box || box.containerId !== containerId) return null;
        box.lastUpdated = now();
        return box;
    }
}

class Sandbox {
    containerId: string;
    lastUpdated: number;
    inputMessage: Message | PartialMessage;
    outputMessage: Message | null;
    dockerContainerId: string | null;

    constructor(inputMessage: Message | PartialMessage) {
        let currentTime = now();
        this.containerId = `sandbox-${currentTime}`;
        this.lastUpdated = currentTime;
        this.inputMessage = inputMessage;
        this.outputMessage = null;
        this.dockerContainerId = null;
    }

    async prepare() {
        let dockerCmd = [
            'docker', 'run',
            `--name=${this.containerId}`,
            '-i', // Interactive mode
            '-t', // Allocate pseudo TTY
            '-d', // Detached
            '--pids-limit', '512',
            '--memory', '256000000',
            '--memory-swap', '256000000',
            '--net', 'none',
            '--entrypoint=\"\"',
            '--cap-drop', 'all',
            '--security-opts', 'no-new-privileges',
            process.env.DOCKER_IMAGE,
            '/bin/bash'
        ];
    
        let stdio = await exec(dockerCmd.join(' '));
    
        if (stdio.stderr) {
            console.log('Failed to start docker container');
        }
    }

    async sendOuput(output: string) {
        if (this.outputMessage) {
            await this.outputMessage.edit(output).catch(console.error);
        } else {
            this.outputMessage = await this.inputMessage.channel.send(output).catch(
                error => {
                    console.error(error);
                    return null;
                }
            );
        }
    }

    async destroy(silent: boolean) {
        await exec(`docker kill ${this.containerId}`).catch(() => {
            if (!silent) console.log(`Failed to kill container ${this.containerId}`)
        });

        await exec(`docker rm -f ${this.containerId}`).catch(() => {
            if (!silent) console.log(`Failed to remove container ${this.containerId}`)
        });
    }

    async copySourceFile(localSource: string) {
        let stdio = await exec(`docker cp ${localSource} ${this.containerId}:/usr/src`);
        if (stdio.stderr) {
            throw new Error(stdio.stderr);
        }
    }

    async execInContainer(command: string): Promise<{stdout: string, stderr: string}> {
        let stdio;
        try {
            stdio = await exec(`docker exec ${this.containerId} ${command}`);
        } catch (error: any) {
            stdio = {
                stdout: error.stdout,
                stderr: error.stderr
            };
        }
        return stdio;
    }
}
