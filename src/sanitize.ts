function isAllowedAscii(by: number): boolean {
    return by == 10 || by == 12 || (by >= 32 && by <= 126);
}

export function asciiify(input: string, filter = (_: number) => true): string {
    let sourceBytes = Buffer.from(input);
    let destBytes = Buffer.alloc(sourceBytes.length);
    let destLen = 0;
    for (let i = 0; i < sourceBytes.length; ++i) {
        let by = sourceBytes[i];
        if (isAllowedAscii(by) && filter(by)) {
            destBytes[destLen] = by;
            ++ destLen;
        }
    }
    return destBytes.toString('utf-8', 0, destLen);
}

export function sanitizeOutput(output: string): string {
    output = asciiify(output, by => by != 96).trim();

    if (output) {
        output = '```cpp\n' + output + '\n```';
    }

    if (output.length > 800) {
        output = 'Full output too long to display.\n' + output.substring(0, 800).trim() + '\n```';
    }

    let i = 0, newLineCount = 0;

    for (; i < output.length && newLineCount < 30; ++i) {
        if (output.charAt(i) == '\n' || output.charAt(i) == '\r') {
            newLineCount += 1;
        }
    }

    if (i < output.length) {
        output = output.substring(0, i).trim() + '\n```';
    }

    return output;
}