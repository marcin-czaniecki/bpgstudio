import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface SqlEditorHandle {
  /** Current text. Read at action time; the editor text is not kept in React state. */
  getText(): string;
  /** Moves the cursor to a 1-based character offset (e.g. a SQL error position). */
  focusAt(position: number): void;
  /** Table/column names for autocompletion, keyed "table" or "schema.table". */
  setSchema(schema: SqlSchema): void;
  /** Inserts text at the cursor (replacing the selection) and refocuses. */
  insertText(text: string): void;
}

export type SqlSchema = Record<string, string[]>;

const DEFAULT_SCHEMA = "public";

function sqlLanguage(schema: SqlSchema) {
  return sql({ dialect: PostgreSQL, schema, defaultSchema: DEFAULT_SCHEMA });
}

interface Props {
  initialText?: string;
  onRun: () => void;
}

const theme = EditorView.theme(
  {
    "&": {
      color: "#f9fafb",
      backgroundColor: "#111827",
      border: "1px solid #374151",
      borderRadius: "8px",
      minHeight: "10rem",
      maxHeight: "24rem",
    },
    ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, monospace" },
    ".cm-gutters": {
      backgroundColor: "#111827",
      color: "#6b7280",
      border: "none",
    },
    "&.cm-focused": { outline: "2px solid #60a5fa" },
  },
  { dark: true },
);

/** CodeMirror 6 SQL editor (PostgreSQL dialect). Ctrl/Cmd+Enter runs the query. */
export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { initialText = "select 1 as one;", onRun },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The keymap is created once; always call the latest callback.
  const run = useRef(onRun);
  run.current = onRun;
  // Only seeds the document once; later prop changes are ignored on purpose.
  const seed = useRef(initialText);
  const language = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: seed.current,
        extensions: [
          basicSetup,
          language.current.of(sqlLanguage({})),
          theme,
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  run.current();
                  return true;
                },
              },
            ]),
          ),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    insertText: (text) => {
      const editor = view.current;
      if (!editor) return;
      editor.dispatch(editor.state.replaceSelection(text));
      editor.focus();
    },
    setSchema: (schema) => {
      view.current?.dispatch({
        effects: language.current.reconfigure(sqlLanguage(schema)),
      });
    },
    getText: () => view.current?.state.doc.toString() ?? "",
    focusAt: (position) => {
      const editor = view.current;
      if (!editor) return;
      const at = Math.max(0, Math.min(position - 1, editor.state.doc.length));
      editor.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      editor.focus();
    },
  }));

  return <div ref={host} />;
});
