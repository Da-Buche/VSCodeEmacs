import * as vscode from 'vscode';
import {Operation} from './operation';

var inMarkMode: boolean = false;
var markHasMoved: boolean = false;
export function activate(context: vscode.ExtensionContext): void {
    let op = new Operation(),
        commandList: string[] = [
            "C-g",

            // Edit
            "C-k", "C-w", "M-w", "C-y", "C-x_C-o",
            "C-x_u", "C-/", "C-j", "C-S_bs",
            "deleteLeft", "deleteRight",

            // Navigation
            "C-l", "shellCommand"
        ],
        cursorMoves: string[] = [
            "cursorUp", "cursorDown", "cursorLeft", "cursorRight",
            "cursorHome", "cursorLineStart", "cursorEnd",
            "cursorWordLeft", "cursorWordRight",
            "cursorPageDown", "cursorPageUp",
            "cursorTop", "cursorBottom"
        ];

    commandList.forEach(commandName => {
        context.subscriptions.push(registerCommand(commandName, op));
    });

    cursorMoves.forEach(element => {
        context.subscriptions.push(vscode.commands.registerCommand(
            "emacs."+element, () => {
                if (inMarkMode) {
                    markHasMoved  = true;
                }
                vscode.commands.executeCommand(
                    inMarkMode ?
                    element+"Select" :
                    element
                );
            })
        )
    });

    context.subscriptions.push(vscode.commands.registerCommand(
        "emacs.cursorPrevBlankLine", () => {
            if (inMarkMode) {
                markHasMoved = true;
            }
            vscode.commands.executeCommand("cursorMove", {
                to: "prevBlankLine",
                select: inMarkMode
            });
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand(
        "emacs.cursorPrevBlankLineSelect", () => {
            markHasMoved = true;
            vscode.commands.executeCommand("cursorMove", {
                to: "prevBlankLine",
                select: true
            });
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand(
        "emacs.cursorNextBlankLine", () => {
            if (inMarkMode) {
                markHasMoved = true;
            }
            vscode.commands.executeCommand("cursorMove", {
                to: "nextBlankLine",
                select: inMarkMode
            });
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand(
        "emacs.cursorNextBlankLineSelect", () => {
            markHasMoved = true;
            vscode.commands.executeCommand("cursorMove", {
                to: "nextBlankLine",
                select: true
            });
        })
    );

    initMarkMode(context);
}

export function deactivate(): void {
}

function initMarkMode(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand(
        'emacs.enterMarkMode', () => {
            if (inMarkMode && !markHasMoved) {
                inMarkMode = false;
            } else {
                initSelection();
                inMarkMode = true;
                markHasMoved = false;
            }
        })
    );

    context.subscriptions.push(vscode.commands.registerCommand(
        'emacs.exitMarkMode', () => {
            vscode.commands.executeCommand("cancelSelection");
            if (inMarkMode) {
                inMarkMode = false;
            }
        })
    );
}

function registerCommand(commandName: string, op: Operation): vscode.Disposable {
    return vscode.commands.registerCommand("emacs." + commandName, op.getCommand(commandName));
}

function initSelection(): void {
    var currentPosition: vscode.Position = vscode.window.activeTextEditor.selection.active;
    vscode.window.activeTextEditor.selection = new vscode.Selection(currentPosition, currentPosition);
}
