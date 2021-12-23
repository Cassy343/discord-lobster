const { Client, Intents } = require("discord.js");
import { readFile, writeFile, unlink } from "fs/promises";
import { promisify } from "util";
const exec = promisify(require('child_process').exec);
import { asciiify, sanitizeOutput } from "./sanitize";
import { SandboxStore } from "./sandbox";

const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES
    ]
});
const sandboxes = new SandboxStore();

const PREFIX: string = '?';

async function destroyContainer(id: string, silent: boolean) {
    await exec(`docker kill ${id}`).catch(() => {
        if (!silent) console.log(`Failed to kill container ${id}`)
    });
    await exec(`docker rm -f ${id}`).catch(() => {
        if (!silent) console.log(`Failed to remove container ${id}`)
    });
}

async function execAndCaptureOutput(command: string) {
    let stdio;
    try {
        stdio = await exec(command);
    } catch (error) {
        stdio = {
            stdout: error.stdout,
            stderr: error.stderr
        };
    }
    return stdio;
}

async function runTemplate(
    sandboxId: string,
    code: string,
    template: string,
    command: (file: string) => string
) {
    if (code.includes('#')) {
        await sandboxes.sendSandboxOutput(
            sandboxId,
            'You cannot include additional headers in your code. Due to the complexity of C++, ' +
            'this means that you cannot include the \'#\' character in your code.'
        );
        return;
    }

    template = (await readFile(template)).toString();
    code = template.replace('%CODE', code);
    let fileName = 'main-' + (new Date()).getTime();
    let sourceFile = fileName + '.cpp';
    let objectFile = fileName + '.o';
    let containerName = `exec-${fileName}`;
    
    await writeFile(sourceFile, code);

    let dockerCmd = [
        'docker', 'run',
        `--name=${containerName}`,
        '-i', // Interactive mode
        '-t', // Allocate pseudo TTY
        '-d', // Detached
        '--pids-limit', '512',
        '--memory', '256000000',
        '--memory-swap', '256000000',
        '--net', 'none',
        '--entrypoint=\"\"',
        process.env.DOCKER_IMAGE,
        '/bin/bash'
    ];

    let stdio;
    stdio = await exec(dockerCmd.join(' '));

    if (stdio.stderr) {
        console.log('Failed to start docker container');
        return;
    }

    await sandboxes.setContainerId(sandboxId, containerName);

    await exec(`docker cp ${sourceFile} ${containerName}:/usr/src/`);
    await unlink(sourceFile);

    setTimeout(() => {
        destroyContainer(containerName, true);
    }, 5000);

    stdio = await execAndCaptureOutput(
        `docker exec ${containerName} g++ /usr/src/${sourceFile} -o /usr/src/${objectFile}`
        );

    if (stdio.stderr) {
        await sandboxes.sendSandboxOutput(
            sandboxId,
            `Compilation failed. ${sanitizeOutput(stdio.stderr)}`
        );
        return;
    }
    
    stdio = await execAndCaptureOutput(
        `docker exec ${containerName} ${command(`/usr/src/${objectFile}`)}`
    );
    destroyContainer(containerName, false);

    let message;
    if (stdio.stderr) {
        message = sanitizeOutput(stdio.stderr);
    } else if (stdio.stdout) {
        message = sanitizeOutput(stdio.stdout);
    } else {
        message = '';
    }

    message = message ? message : 'No output';
    await sandboxes.sendSandboxOutput(sandboxId, message);
}

function determinePlayTemplate(code: string): string {
    let template;

    if (/.*int\s+main\s*\(.*\)\s*{(.|\n)*}.*/.test(code)) {
        template = 'play-no-main.cpp.template';
    } else {
        template = 'play.cpp.template';
    }

    return template;
}

async function play(sandboxId: string, code: string) {
    await runTemplate(sandboxId, code, determinePlayTemplate(code), file => file);
}

async function cppEval(sandboxId: string, code: string) {
    await runTemplate(sandboxId, code, 'eval.cpp.template', file => file);
}

async function valgrind(sandboxId: string, code: string) {
    await runTemplate(sandboxId, code, determinePlayTemplate(code), file => `valgrind ${file}`);
}

function isolateCode(sandboxId, commandLength: number, messageContent: string): string {
    messageContent = messageContent.substring(commandLength).trim();
    
    if (
        (messageContent.startsWith('```cpp') || messageContent.startsWith('```c++')) &&
        messageContent.endsWith('```')
    ) {
        return messageContent.substring(6, messageContent.length - 3).trim();
    } else if (messageContent.startsWith('```') && messageContent.endsWith('```')) {
        return messageContent.substring(3, messageContent.length - 3).trim();
    } else if (messageContent.startsWith('`') && messageContent.endsWith('`')) {
        return messageContent.substring(1, messageContent.length - 1).trim();
    } else {
        sandboxes.sendSandboxOutput(
            sandboxId,
            'Missing code block. Try wrapping your code with \\`...\\` or ' +
            '\\`\\`\\`cpp ... \\`\\`\\`.'
        );
        return null;
    }
}

async function parseCommand(message, newMessage) {
    let mostRecent = newMessage ? newMessage : message;
    let content: string = mostRecent.content;

    if (!content.startsWith(PREFIX)) {
        return;
    }

    content = asciiify(content.substring(1));

    let authorId = message.author.id;
    let oldContainer = sandboxes.getSandbox(authorId, mostRecent, message.id);

    if (oldContainer) {
        destroyContainer(oldContainer, true);
    }

    let code: string;
    let evaluator;

    if (content.startsWith('play')) {
        code = isolateCode(authorId, 4, content);
        evaluator = play;
    } else if (content.startsWith('eval')) {
        code = isolateCode(authorId, 4, content);
        evaluator = cppEval;
    } else if (content.startsWith('valgrind')) {
        code = isolateCode(authorId, 8, content);
        evaluator = valgrind;
    } else {
        return;
    }

    if (!code) {
        return;
    }

    await evaluator(authorId, code);
}

client.on("ready", () => {
    console.log(`Logged in as ${client.user.tag}!`)
});

client.on("messageCreate", async msg => {
    await parseCommand(msg, null)
        .catch(error => console.log(`Failed to parse command: ${error}`));
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (!sandboxes.isSandboxActive(oldMessage.author.id)) {
        return;
    }

    await parseCommand(oldMessage, newMessage)
        .catch(error => console.log(`Failed to parse command: ${error}`));
});

client.login(process.env.TOKEN);
