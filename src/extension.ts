// src/extension.ts
import * as vscode from 'vscode';
import { extractEntities, generateSuggestions, LoopSuggestion } from './loop-generator';

/**
 * Точка активации расширения.
 * Регистрирует две команды: обёртывание в for и в while.
 *
 * @param context Контекст расширения, предоставленный VS Code.
 */
export function activate(context: vscode.ExtensionContext) {
    const disposableFor = vscode.commands.registerCommand(
        'cppLoopGenerator.wrapInFor',
        () => wrapSelection('for')
    );
    const disposableWhile = vscode.commands.registerCommand(
        'cppLoopGenerator.wrapInWhile',
        () => wrapSelection('while')
    );
    context.subscriptions.push(disposableFor, disposableWhile);
}

/**
 * Основной сценарий обёртывания выделения.
 *
 * 1. Получает активный редактор и выделение.
 * 2. Извлекает сущности из текста.
 * 3. Строит и ранжирует предложения.
 * 4. Фильтрует по запрошенному типу цикла.
 * 5. При необходимости показывает QuickPick.
 * 6. Форматирует и вставляет итоговый блок.
 *
 * @param preferredType Тип цикла, инициированный пользователем.
 */
async function wrapSelection(preferredType: 'for' | 'while') {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Нет активного редактора');
        return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
        vscode.window.showErrorMessage('Выделите фрагмент кода');
        return;
    }

    const selectedText = editor.document.getText(selection);
    const entities = extractEntities(selectedText);
    const suggestions = generateSuggestions(entities);

    // Фильтруем строго по запрошенному типу. Благодаря fallback-каркасам
    // из generateSuggestions массив finalSuggestions никогда не окажется
    // пустым, поэтому подмены типа не происходит.
    const finalSuggestions = suggestions.filter(s => s.loopType === preferredType);

    let chosen: LoopSuggestion;
    if (finalSuggestions.length === 1) {
        chosen = finalSuggestions[0];
    } else {
        const items = finalSuggestions.map(s => ({
            label: s.header,
            description: s.description,
            detail: `Тип: ${s.loopType}`
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Выберите вариант цикла'
        });
        if (!picked) return;
        chosen = finalSuggestions.find(s => s.header === picked.label)!;
    }

    const indent = getIndent(editor, selection.start.line);
    const body = indentLines(selectedText, indent + '    ');
    const loopBlock = `${chosen.header} {\n${body}\n${indent}}`;

    await editor.edit(editBuilder => {
        editBuilder.replace(selection, loopBlock);
    });
}

/**
 * Возвращает строку отступа для указанной строки документа.
 *
 * @param editor Активный редактор.
 * @param line   Номер строки (0-based).
 * @returns      Строка из пробелов/табов в начале.
 */
function getIndent(editor: vscode.TextEditor, line: number): string {
    const lineText = editor.document.lineAt(line).text;
    const match = lineText.match(/^\s*/);
    return match ? match[0] : '';
}

/**
 * Добавляет указанный отступ к каждой строке текста.
 *
 * @param text   Многострочный текст.
 * @param indent Строка отступа.
 * @returns      Текст с добавленным отступом.
 */
function indentLines(text: string, indent: string): string {
    return text.split('\n').map(line => indent + line).join('\n');
}

export function deactivate() {}