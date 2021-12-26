import { Client, Intents, Message, PartialMessage } from "discord.js";
import { readFile, writeFile, unlink } from "fs/promises";
import { SandboxStore } from "./sandbox";

const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES
    ]
});
const sandboxes = new SandboxStore();

const PREFIX: string = '?';

function sanitizeOutput(output: string): string {
    output = Array.from(output.replace(/[^\x20-\x7F\n]/g, '')).filter(char => char != '`').join('').trim();

    if (!output) {
        return '';
    }

    output = '```cpp\n' + output + '\n```';

    if (output.length > 800) {
        output = 'Full output too long to display.\n' + output.substring(0, 800).trim() + '\n```';
    }

    let i = 0;
    let newLineCount = 0;

    for (; i < output.length && newLineCount < 30; ++i) {
        if (output.charAt(i) == '\n') {
            newLineCount += 1;
        }
    }

    if (i < output.length) {
        output = output.substring(0, i).trim() + '\n```';
    }

    return output;
}

async function runTemplate(
    sandboxId: string,
    containerId: string,
    code: string,
    command: (file: string) => string
) {
    let fileName = 'main-' + (new Date()).getTime();
    let sourceFile = fileName + '.cpp';
    let objectFile = fileName + '.o';
    let containerName = `exec-${fileName}`;
    
    await writeFile(sourceFile, code);
    await sandboxes.copySourceFile(sandboxId, containerId, sourceFile);
    await unlink(sourceFile);

    sandboxes.startDestroyTimout(sandboxId, containerId);

    let stdio = await sandboxes.execInContainer(
        sandboxId,
        containerId,
        `g++ /usr/src/${sourceFile} -o /usr/src/${objectFile}`
    );

    if (!stdio) return;
    else if (stdio.stderr) {
        await sandboxes.sendOuput(
            sandboxId,
            containerId,
            `Compilation failed. ${sanitizeOutput(stdio.stderr)}`
        );
        return;
    }
    
    stdio = await sandboxes.execInContainer(
        sandboxId,
        containerId,
        `${command(`/usr/src/${objectFile}`)}`
    );
    if (!stdio) return;

    await sandboxes.destroyContainer(sandboxId, containerId);

    let message;
    if (stdio.stderr) {
        message = sanitizeOutput(stdio.stderr);
    } else if (stdio.stdout) {
        message = sanitizeOutput(stdio.stdout);
    } else {
        message = '';
    }

    message = message ? message : 'No output';
    await sandboxes.sendOuput(sandboxId, containerId, message);
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

async function applyTemplate(code: string, templateFile: string): Promise<string> {
    let template = (await readFile(templateFile)).toString();
    return template.replace('%CODE', code);
}

async function play(sandboxId: string, containerId: string, code: string) {
    let template = determinePlayTemplate(code);
    await runTemplate(
        sandboxId,
        containerId,
        await applyTemplate(code, template),
        file => file
    );
}

async function cppEval(sandboxId: string, containerId: string, code: string) {
    await runTemplate(
        sandboxId,
        containerId,
        await applyTemplate(code, 'eval.cpp.template'),
        file => file
    );
}

async function valgrind(sandboxId: string, containerId: string, code: string) {
    let template = determinePlayTemplate(code);
    await runTemplate(
        sandboxId,
        containerId,
        await applyTemplate(code, template),
        file => `valgrind ${file}`
    );
}

function isolateCode(commandLength: number, messageContent: string): string {
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
        throw new Error();
    }
}

async function parseCommand(
    content: string,
    inputMessage: Message | PartialMessage,
    transferOutput: (oldMessage: Message | PartialMessage) => boolean
) {
    if (!content.startsWith(PREFIX) || !inputMessage.author) {
        return;
    }

    content = Array.from(content.substring(1).replace(/[^\x20-\x7F\n]/g, "")).join('');

    let id = inputMessage.author.id;
    let containerId = await sandboxes.newSandbox(id, inputMessage, transferOutput);

    let code: string;
    let evaluator;

    try {
        if (content.startsWith('play')) {
            code = isolateCode(4, content);
            evaluator = play;
        } else if (content.startsWith('eval')) {
            code = isolateCode(4, content);
            evaluator = cppEval;
        } else if (content.startsWith('valgrind')) {
            code = isolateCode(8, content);
            evaluator = valgrind;
        } else {
            return;
        }
    } catch (error: any) {
        sandboxes.sendOuput(
            id,
            containerId,
            'Missing code block. Try wrapping your code with \\`...\\` or ' +
                '\\`\\`\\`cpp ... \\`\\`\\`.'
        );
        return;
    }

    if (content.includes('#')) {
        await sandboxes.sendOuput(
            id,
            containerId,
            'You cannot include additional headers in your code. Due to the complexity of C++, ' +
            'this means that you cannot include the \'#\' character in your code.'
        );
        return;
    }

    await evaluator(id, containerId, code);
}

client.on("ready", () => {
    if (client.user == null) {
        console.error("Client user is null");
        return;
    }

    console.log(`Logged in as ${client.user.tag}!`)
});

client.on("messageCreate", async msg => {
    await parseCommand(msg.content, msg, _ => false)
        .catch(error => console.log(`Failed to parse command: ${error}`));
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (!newMessage.content) {
        return;
    }

    await parseCommand(newMessage.content, newMessage, (msg: Message | PartialMessage) => msg.id === oldMessage.id)
        .catch(error => console.log(`Failed to parse command: ${error}`));
});

client.login(process.env.TOKEN);
