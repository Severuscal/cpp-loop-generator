// src/loopGenerator.ts
import * as vscode from 'vscode';

/**
 * Сущность, извлечённая из выделенного кода.
 * Используется как структура данных для последующей генерации предложений.
 */
export class CodeEntity {
    /**
     * @param kind      Тип сущности ('arrayAccess' | 'condition' | 'variable').
     * @param name      Имя сущности (имя массива, текст условия, имя переменной).
     * @param index     Индекс для обращения к массиву (опционально).
     * @param rawText   Исходный текст совпадения (для отладки).
     */
    constructor(
        public readonly kind: 'arrayAccess' | 'condition' | 'variable',
        public readonly name: string,
        public readonly index?: string,
        public readonly rawText?: string
    ) {}
}

/**
 * Предложение по циклу. Хранит готовый заголовок, описание
 * и приоритет для сортировки вариантов.
 */
export class LoopSuggestion {
    /**
     * @param loopType    Тип цикла ('for' | 'while').
     * @param header      Заголовок цикла (без тела).
     * @param description Человекочитаемое описание варианта.
     * @param priority    Вес для сортировки (больше — важнее).
     */
    constructor(
        public readonly loopType: 'for' | 'while',
        public readonly header: string,
        public readonly description: string,
        public readonly priority: number
    ) {}
}

/**
 * Извлекает сущности из выделенного фрагмента C++ кода.
 *
 * Проходит по тексту тремя регулярными выражениями: обращения к массиву,
 * условия внутри if/while, отдельные идентификаторы. Возвращает массив
 * объектов {@link CodeEntity}.
 *
 * @param text Фрагмент кода, выделенный пользователем.
 * @returns    Массив найденных сущностей.
 */
export function extractEntities(text: string): CodeEntity[] {
    const entities: CodeEntity[] = [];

    // 1. Обращение к массиву: arr[i] или vec[idx]
    const arrayAccessRegex = /(\w+)\s*\[\s*(\w+)\s*\]/g;
    let match: RegExpExecArray | null;
    while ((match = arrayAccessRegex.exec(text)) !== null) {
        entities.push(new CodeEntity('arrayAccess', match[1], match[2], match[0]));
    }

    // 2. Условия в if/while
    const conditionRegex = /(?:if|while)\s*\(\s*([^)]+)\)/g;
    while ((match = conditionRegex.exec(text)) !== null) {
        entities.push(new CodeEntity('condition', match[1].trim(), undefined, match[0]));
    }

    // 2.5. «Голое» условие без обёртки if/while — например "count < 10",
    //      "i != n", "x == 0". Полезно, когда пользователь просто выделил
    //      выражение и хочет превратить его в заголовок цикла.
    const bareConditionRegex = /([a-zA-Z_]\w*\s*(?:<=|>=|==|!=|<|>)\s*[\w'".\d]+)/g;
    while ((match = bareConditionRegex.exec(text)) !== null) {
        entities.push(new CodeEntity('condition', match[1].trim(), undefined, match[0]));
    }

    // 3. Только если вообще ничего не нашли — извлекаем идентификаторы
    if (entities.length === 0) {
        const varRegex = /\b([a-zA-Z_]\w*)\b/g;
        const seen = new Set<string>();
        const keywords = ['if', 'else', 'for', 'while', 'return', 'int', 'double'];
        while ((match = varRegex.exec(text)) !== null) {
            const name = match[1];
            if (!seen.has(name) && !keywords.includes(name)) {
                seen.add(name);
                entities.push(new CodeEntity('variable', name));
            }
        }
    }

    return entities;
}

/**
 * Строит список предложений по циклам на основе извлечённых сущностей.
 *
 * Для каждой сущности генерируется один или несколько вариантов.
 * В конце массив сортируется по убыванию приоритета, чтобы более
 * релевантный вариант оказался первым.
 *
 * ВАЖНО: в конце всегда добавляются стандартные каркасы обоих типов
 * (`for` и `while`) с минимальным приоритетом. Это гарантирует, что
 * при фильтрации по запрошенному типу (см. wrapSelection) массив
 * никогда не окажется пустым, и пользователь не получит цикл другого
 * типа из-за «тихого отката».
 *
 * @param entities Массив сущностей из {@link extractEntities}.
 * @returns        Отсортированный массив предложений.
 */
export function generateSuggestions(entities: CodeEntity[]): LoopSuggestion[] {
    const suggestions: LoopSuggestion[] = [];

    for (const entity of entities) {
        if (entity.kind === 'arrayAccess' && entity.index) {
            // for по индексу массива
            suggestions.push(new LoopSuggestion(
                'for',
                `for (size_t ${entity.index} = 0; ${entity.index} < ${entity.name}.size(); ++${entity.index})`,
                `Итерация по ${entity.name} с индексом ${entity.index}`,
                10
            ));
            // range-based for
            suggestions.push(new LoopSuggestion(
                'for',
                `for (const auto& item : ${entity.name})`,
                `Range-based for по ${entity.name}`,
                5
            ));
            // while по индексу — с явной подсказкой про инкремент
            suggestions.push(new LoopSuggestion(
                'while',
                `while (${entity.index} < ${entity.name}.size())`,
                `while по индексу ${entity.index} — не забудьте ${entity.index}++ внутри`,
                3
            ));
        }

        if (entity.kind === 'condition') {
            // while с тем же условием
            suggestions.push(new LoopSuggestion(
                'while',
                `while (${entity.name})`,
                `Повторять, пока выполняется условие «${entity.name}»`,
                8
            ));

            // Пытаемся распознать сравнение вида "var OP bound" и собрать for
            const cmp = entity.name.match(
                /^\s*([a-zA-Z_]\w*)\s*(<=|>=|<|>|==|!=)\s*(.+?)\s*$/
            );
            if (cmp) {
                const lhs = cmp[1];
                const op = cmp[2];
                const rhs = cmp[3];
                const step = (op === '>' || op === '>=') ? `--${lhs}` : `++${lhs}`;
                const cond = (op === '==' || op === '!=')
                    ? `${lhs} ${op} ${rhs}`
                    : `${lhs} < ${rhs}`;
                suggestions.push(new LoopSuggestion(
                    'for',
                    `for (int ${lhs} = 0; ${cond}; ${step})`,
                    `Счётчик ${lhs} до ${rhs} (проверьте начальное значение и знак)`,
                    4
                ));
            }
        }

        if (entity.kind === 'variable') {
            // for с переменной как счётчиком
            suggestions.push(new LoopSuggestion(
                'for',
                `for (int ${entity.name} = 0; ${entity.name} < N; ++${entity.name})`,
                `Использовать ${entity.name} как счётчик (замените N на нужное значение)`,
                1
            ));
        }
    }

    // Всегда добавляем стандартные каркасы обоих типов с минимальным
    // приоритетом. Это гарантирует, что при фильтрации по запрошенному
    // типу (for/while) в wrapSelection всегда будет хотя бы один вариант,
    // и не возникнет ситуации, когда пользователь просит while, а
    // подставляется for (или наоборот).
    suggestions.push(new LoopSuggestion(
        'for',
        'for (int i = 0; i < N; ++i)',
        'Стандартный for (замените N на нужное значение)',
        0
    ));
    suggestions.push(new LoopSuggestion(
        'while',
        'while (condition)',
        'Стандартный while (замените condition)',
        0
    ));

    return suggestions.sort((a, b) => b.priority - a.priority);
}