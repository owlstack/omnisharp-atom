// tslint:disable-next-line:max-file-line-count
import * as fs from 'fs';
import { each, endsWith, every, filter, find, first, flatMap, isFunction, map, some, trimStart } from 'lodash';
import { Models } from 'omnisharp-client';
import { DriverState } from 'omnisharp-client';
import { createObservable } from 'omnisharp-client';
import * as path from 'path';
import { BehaviorSubject, Observable, ReplaySubject, Scheduler, Subject } from 'rxjs';
import { gt as semverGt, SemVer } from 'semver';
import { CompositeDisposable, Disposable, IDisposable } from 'ts-disposables';
import { metadataOpener } from './metadata-editor';
import { isOmnisharpTextEditor, OmnisharpEditorContext, IOmnisharpTextEditor } from './omnisharp-text-editor';
import { ProjectViewModel } from './project-view-model';
import { Solution } from './solution';
import { SolutionManager } from './solution-manager';
import { ViewModel } from './view-model';

// Time we wait to try and do our active switch tasks.
const DEBOUNCE_TIMEOUT = 100;
const statefulProperties = ['isOff', 'isConnecting', 'isOn', 'isReady', 'isError'];

function wrapEditorObservable(observable: Observable<IOmnisharpTextEditor>) {
    return observable
        .subscribeOn(Scheduler.async)
        .observeOn(Scheduler.async)
        .filter(editor => !editor || editor && !editor.isDestroyed());
}

class OmniManager implements IDisposable {
    private disposable: CompositeDisposable;

    private _editors: Observable<IOmnisharpTextEditor>;
    private _configEditors: Observable<IOmnisharpTextEditor>;
    private _underlyingEditors = new Set<IOmnisharpTextEditor>();
    private _supportedExtensions = ['project.json', '.cs', '.csx'];
    private _packageDir: string;
    private _atomVersion: SemVer;

    public get viewModelStatefulProperties() { return statefulProperties; }

    private _activeEditorOrConfigEditorSubject = new BehaviorSubject<IOmnisharpTextEditor>(null);
    private _activeEditorOrConfigEditor = wrapEditorObservable(<Observable<IOmnisharpTextEditor>><any>this._activeEditorOrConfigEditorSubject)
        .debounceTime(DEBOUNCE_TIMEOUT)
        .publishReplay(1)
        .refCount();

    private _activeEditor = wrapEditorObservable(<Observable<IOmnisharpTextEditor>><any>this._activeEditorOrConfigEditorSubject)
        .debounceTime(DEBOUNCE_TIMEOUT)
        .map(x => x && x.omnisharp && !x.omnisharp.config ? x : null)
        .publishReplay(1)
        .refCount();

    private _activeConfigEditor = wrapEditorObservable(<Observable<IOmnisharpTextEditor>><any>this._activeEditorOrConfigEditorSubject)
        .debounceTime(DEBOUNCE_TIMEOUT)
        .map(x => x && x.omnisharp && x.omnisharp.config ? x : null)
        .publishReplay(1)
        .refCount();

    private _activeProject = this._activeEditorOrConfigEditor
        .filter(editor => editor && !editor.isDestroyed())
        .switchMap(editor => editor.omnisharp.solution.model.getProjectForEditor(editor))
        .distinctUntilChanged()
        .publishReplay(1)
        .refCount();

    private _activeFramework = this._activeEditorOrConfigEditor
        .filter(editor => editor && !editor.isDestroyed())
        .switchMap(editor => editor.omnisharp.solution.model.getProjectForEditor(editor))
        .switchMap(project => project.observe.activeFramework, (project, framework) => ({ project, framework }))
        .distinctUntilChanged()
        .publishReplay(1)
        .refCount();

    private _diagnosticsSubject = new Subject<Models.DiagnosticLocation[]>();
    private _diagnostics = this._diagnosticsSubject.publishReplay(1).refCount();
    public get diagnostics() { return this._diagnostics; }

    private _diagnosticCountsSubject = new Subject<{ [key: string]: number; }>();
    private _diagnosticCounts = this._diagnosticCountsSubject.publishReplay(1).refCount();
    public get diagnosticsCounts() { return this._diagnosticCounts; }

    private _diagnosticsByFileSubject = new Subject<Map<string, Models.DiagnosticLocation[]>>();
    private _diagnosticsByFile = this._diagnosticsByFileSubject.publishReplay(1).refCount();
    public get diagnosticsByFile() { return this._diagnosticsByFile; }

    private _isOff = true;

    public get isOff() { return this._isOff; }
    public get isOn() { return !this.isOff; }

    // tslint:disable-next-line:max-func-body-length
    public activate() {
        this.disposable = new CompositeDisposable();
        this.disposable.add(metadataOpener());

        const editors = this._createTextEditorObservable(this.disposable);
        this._editors = wrapEditorObservable(editors.filter(x => !x.omnisharp.config));
        this._configEditors = wrapEditorObservable(editors.filter(x => x.omnisharp.config));

        // Restore solutions after the server was disconnected
        this.disposable.add(SolutionManager.activeSolution.subscribe(solution => {
            each(filter(atom.workspace.getTextEditors(), x => this._isOmniSharpEditor(x) && !(<any>x).omnisharp), x => {
                SolutionManager.getSolutionForEditor(x);
            });
        }));

        SolutionManager.activate(this._activeEditorOrConfigEditor);

        // we are only off if all our solutions are disconncted or erroed.
        this.disposable.add(
            SolutionManager.solutionAggregateObserver.state
                .subscribe(z => {
                    this._isOff = every(z, x => x.value === DriverState.Disconnected || x.value === DriverState.Error);
                }));

        this.disposable.add(
            createObservable<Atom.TextEditor>(observer => {
                const dis = atom.workspace.observeActivePaneItem((pane: any) => {
                    if (pane && pane.getGrammar && pane.getPath && this.isValidGrammar(pane.getGrammar())) {
                        observer.next(<Atom.TextEditor>pane);
                        return;
                    }
                    observer.next(null);
                });

                return () => dis.dispose();
            })
                .concatMap(pane => {
                    if (!pane || isOmnisharpTextEditor(pane)) {
                        return Observable.of(pane);
                    }
                    return wrapEditorObservable(
                        SolutionManager.getSolutionForEditor(pane)
                            .map(x => <IOmnisharpTextEditor>pane)
                    );
                })
                .subscribe(this._activeEditorOrConfigEditorSubject));

        this.disposable.add(Disposable.create(() => {
            this._activeEditorOrConfigEditorSubject.next(null);
        }));

        // Cache this result, because the underlying implementation of observe will
        //    create a cache of the last recieved value.  This allows us to pick pick
        //    up from where we left off.
        const codeCheckAggregate = this.aggregateListener.listenTo(z => z.model.observe.diagnostics)
            .debounceTime(200)
            .map(data => flatMap(data, x => x.value));

        const codeCheckCountAggregate = this.aggregateListener.listenTo(z => z.model.observe.diagnosticsCounts)
            .debounceTime(200)
            .map(items => {
                const result: typeof ViewModel.prototype.diagnosticCounts = {};
                each(items, y => {
                    each(y.value, (x, k) => {
                        if (!result[k]) {
                            result[k] = 0;
                        }
                        result[k] += x;
                    });
                });
                return result;
            });

        const codeCheckByFileAggregate = this.aggregateListener.listenTo(z => z.model.observe.diagnosticsByFile.map(x => z.model.diagnosticsByFile))
            .debounceTime(200)
            .map(x => {
                const map = new Map<string, Models.DiagnosticLocation[]>();
                each(x, z => {
                    for (const [file, diagnostics] of z.value) {
                        map.set(file, diagnostics);
                    }
                });
                return map;
            });

        const showDiagnosticsForAllSolutions = new ReplaySubject<boolean>(1);
        this.disposable.add(atom.config.observe('omnisharp-atom.showDiagnosticsForAllSolutions', enabled => {
            showDiagnosticsForAllSolutions.next(enabled);
        }));

        this.disposable.add(showDiagnosticsForAllSolutions);

        const baseDiagnostics = Observable.combineLatest( // Combine both the active model and the configuration changes together
            this.activeModel.startWith(null),
            showDiagnosticsForAllSolutions,
            showDiagnosticsForAllSolutions
                .skip(1)
                .startWith(atom.config.get<boolean>('omnisharp-atom.showDiagnosticsForAllSolutions')),
            (model, enabled, wasEnabled) => ({ model, enabled, wasEnabled }))
            // If the setting is enabled (and hasn"t changed) then we don"t need to redo the subscription
            .filter(ctx => (!(ctx.enabled && ctx.wasEnabled === ctx.enabled)))
            .share();

        this.disposable.add(
            baseDiagnostics
                .switchMap(ctx => {
                    const { enabled, model } = ctx;

                    if (enabled) {
                        return codeCheckAggregate;
                    } else if (model) {
                        return model.observe.diagnostics;
                    }

                    return Observable.of([]);
                })
                .startWith([])
                .subscribe(this._diagnosticsSubject),
            baseDiagnostics
                .switchMap(ctx => {
                    const { enabled, model } = ctx;

                    if (enabled) {
                        return codeCheckCountAggregate;
                    } else if (model) {
                        return model.observe.diagnosticsCounts;
                    }

                    return <any>Observable.empty<{ [index: string]: number; }>();
                })
                .startWith({})
                .subscribe(this._diagnosticCountsSubject),
            baseDiagnostics
                .switchMap(ctx => {
                    const { enabled, model } = ctx;

                    if (enabled) {
                        return codeCheckByFileAggregate;
                    } else if (model) {
                        return model.observe.diagnosticsByFile.map(x => model.diagnosticsByFile);
                    }

                    return Observable.of(new Map<string, Models.DiagnosticLocation[]>());
                })
                .startWith(new Map<string, Models.DiagnosticLocation[]>())
                .subscribe(this._diagnosticsByFileSubject)
        );
    }

    public dispose() {
        if (SolutionManager._unitTestMode_) { return; }
        this.disposable.dispose();
        SolutionManager.deactivate();
    }

    public connect() { SolutionManager.connect(); }

    public disconnect() { SolutionManager.disconnect(); }

    public toggle() {
        if (SolutionManager.connected) {
            SolutionManager.disconnect();
        } else {
            SolutionManager.connect();
        }
    }

    public navigateTo(response: { FileName: string; Line: number; Column: number; }) {
        return Observable.fromPromise(
            atom.workspace.open(response.FileName, <any>{ initialLine: response.Line, initialColumn: response.Column })
        );
    }

    public getFrameworks(projects: string[]): string {
        const frameworks = map(projects, (project: string) => {
            return project.indexOf('+') === -1 ? '' : project.split('+')[1];
        }).filter((fw: string) => fw.length > 0);
        return frameworks.join(',');
    }

    public addTextEditorCommand(commandName: string, callback: (...args: any[]) => any) {
        return atom.commands.add('atom-text-editor', commandName, event => {
            const editor = atom.workspace.getActiveTextEditor();
            if (!editor) {
                return;
            }

            if (some(this._supportedExtensions, ext => endsWith(editor.getPath(), ext))) {
                event.stopPropagation();
                event.stopImmediatePropagation();
                callback(event);
            }
        });
    }

    /**
     * This property can be used to listen to any event that might come across on any solutions.
     * This is a mostly functional replacement for `registerConfiguration`, though there has been
     *     one place where `registerConfiguration` could not be replaced.
     */
    public get listener() {
        return SolutionManager.solutionObserver;
    }

    /**
     * This property can be used to observe to the aggregate or combined responses to any event.
     * A good example of this is, for code check errors, to aggregate all errors across all open solutions.
     */
    public get aggregateListener() {
        return SolutionManager.solutionAggregateObserver;
    }

    /**
     * This property gets a list of solutions as an observable.
     * NOTE: This property will not emit additions or removals of solutions.
     */
    public get solutions() {
        return Observable.defer(() => Observable.from<Solution>(SolutionManager.activeSolutions));
    }

    /*
     * This method allows us to forget about the entire solution model.
     * Call this method with a specific editor, or just with a callback to capture the current editor
     *
     * The callback will then issue the request
     * NOTE: This API only exposes the operation Api and doesn"t expose the event api, as we are requesting something to happen
     */
    public request<T>(editor: Atom.TextEditor, callback: (solution: Solution) => Observable<T>): Observable<T>;
    public request<T>(callback: (solution: Solution) => Observable<T>): Observable<T>;
    public request<T>(
        editor: Atom.TextEditor | ((solution: Solution) => Observable<T> | Promise<T>),
        callback?: (solution: Solution) => Observable<T>): Observable<T> {
        if (isFunction(editor)) {
            callback = <any>editor;
            editor = null;
        }

        if (!editor) {
            editor = atom.workspace.getActiveTextEditor();
        }

        const solutionCallback = (solution: Solution) => callback(solution.withEditor(<any>editor));

        let result: Observable<T>;
        if (editor && isOmnisharpTextEditor(editor)) {
            result = solutionCallback(editor.omnisharp.solution)
                .share();
            result.subscribe();
            return result;
        }

        let solutionResult: Observable<Solution>;
        if (editor) {
            solutionResult = SolutionManager.getSolutionForEditor(<Atom.TextEditor>editor);
        } else {
            solutionResult = SolutionManager.activeSolution.take(1);
        }

        result = solutionResult
            .filter(z => !!z)
            .flatMap(solutionCallback)
            .share();

        // Ensure that the underying promise is connected
        //   (if we don"t subscribe to the reuslt of the request, which is not a requirement).
        result.subscribe();

        return result;
    }

    public getProject(editor: Atom.TextEditor) {
        if (isOmnisharpTextEditor(editor) && editor.omnisharp.project) {
            return Observable.of(editor.omnisharp.project);
        }

        return SolutionManager.getSolutionForEditor(editor)
            .flatMap(z => z.model.getProjectForEditor(editor))
            .take(1);
    }

    public getSolutionForProject(project: ProjectViewModel<any>) {
        return Observable.of(
            first(filter(SolutionManager.activeSolutions, solution => some(solution.model.projects, p => p.name === project.name)))
        );
    }

    public getSolutionForEditor(editor: Atom.TextEditor) {
        if (isOmnisharpTextEditor(editor)) {
            return Observable.of(editor.omnisharp.solution);
        }

        return SolutionManager.getSolutionForEditor(editor);
    }

    /**
     * Allows for views to observe the active model as it changes between editors
     */
    public get activeModel() {
        return SolutionManager.activeSolution.map(z => z.model);
    }

    public switchActiveModel(callback: (model: ViewModel, cd: CompositeDisposable) => void): IDisposable {
        const outerCd = new CompositeDisposable();
        outerCd.add(this.activeModel.filter(z => !!z).subscribe(model => {
            const cd = new CompositeDisposable();
            outerCd.add(cd);
            model.disposable.add(cd);

            cd.add(this.activeModel.filter(active => active !== model)
                .subscribe(() => {
                    model.disposable.remove(cd);
                    outerCd.remove(cd);
                    cd.dispose();
                }));

            callback(model, cd);
        }));

        return outerCd;
    }

    public get activeSolution() {
        return SolutionManager.activeSolution;
    }

    public switchActiveSolution(callback: (solution: Solution, cd: CompositeDisposable) => void): IDisposable {
        const outerCd = new CompositeDisposable();
        outerCd.add(this.activeSolution.filter(z => !!z).subscribe(solution => {
            const cd = new CompositeDisposable();
            outerCd.add(cd);
            solution.disposable.add(cd);

            cd.add(this.activeSolution.filter(active => active !== solution)
                .subscribe(() => {
                    solution.disposable.remove(cd);
                    outerCd.remove(cd);
                    cd.dispose();
                }));

            callback(solution, cd);
        }));

        return outerCd;
    }

    public get activeEditor() {
        return this._activeEditor;
    }

    public switchActiveEditor(callback: (editor: IOmnisharpTextEditor, cd: CompositeDisposable) => void): IDisposable {
        const outerCd = new CompositeDisposable();
        outerCd.add(this.activeEditor.filter(z => !!z).subscribe(editor => {
            const cd = new CompositeDisposable();
            outerCd.add(cd);
            editor.omnisharp.solution.disposable.add(cd);

            cd.add(this.activeEditor.filter(active => active !== editor)
                .subscribe(() => {
                    editor.omnisharp.solution.disposable.remove(cd);
                    outerCd.remove(cd);
                    cd.dispose();
                }));

            callback(editor, cd);
        }));

        return outerCd;
    }

    public whenEditorConnected(editor: Atom.TextEditor) {
        if (isOmnisharpTextEditor(editor)) {
            return editor.omnisharp.solution
                .whenConnected()
                .map(z => editor);
        }

        return SolutionManager.getSolutionForEditor(editor)
            .flatMap(solution => solution.whenConnected(), () => <IOmnisharpTextEditor>editor);
    }

    public get activeConfigEditor() {
        return this._activeConfigEditor;
    }

    public switchActiveConfigEditor(callback: (editor: IOmnisharpTextEditor, cd: CompositeDisposable) => void): IDisposable {
        const outerCd = new CompositeDisposable();
        outerCd.add(this.activeConfigEditor.filter(z => !!z).subscribe(editor => {
            const cd = new CompositeDisposable();
            outerCd.add(cd);
            editor.omnisharp.solution.disposable.add(cd);

            cd.add(this.activeConfigEditor.filter(active => active !== editor)
                .subscribe(() => {
                    editor.omnisharp.solution.disposable.remove(cd);
                    outerCd.remove(cd);
                    cd.dispose();
                }));

            callback(editor, cd);
        }));

        return outerCd;
    }

    public get activeEditorOrConfigEditor() {
        return this._activeEditorOrConfigEditor;
    }

    public switchActiveEditorOrConfigEditor(callback: (editor: IOmnisharpTextEditor, cd: CompositeDisposable) => void): IDisposable {
        const outerCd = new CompositeDisposable();
        outerCd.add(this.activeEditorOrConfigEditor.filter(z => !!z).subscribe(editor => {
            const cd = new CompositeDisposable();
            outerCd.add(cd);

            cd.add(this.activeEditorOrConfigEditor.filter(active => active !== editor)
                .subscribe(() => {
                    outerCd.remove(cd);
                    cd.dispose();
                }));

            callback(editor, cd);
        }));

        return outerCd;
    }

    public get activeProject() {
        return this._activeProject;
    }

    public get activeFramework() {
        return this._activeFramework;
    }

    public get editors() {
        return this._editors;
    }

    public get configEditors() {
        return this._configEditors;
    }

    public eachEditor(callback: (editor: IOmnisharpTextEditor, cd: CompositeDisposable) => void): IDisposable {
        const outerCd = new CompositeDisposable();
        outerCd.add(this._editors.subscribe(editor => {
            const cd = new CompositeDisposable();
            outerCd.add(cd);
            editor.omnisharp.solution.disposable.add(cd);

            cd.add(editor.onDidDestroy((() => {
                editor.omnisharp.solution.disposable.remove(cd);
                outerCd.remove(cd);
                cd.dispose();
            })));

            callback(editor, cd);
        }));

        return outerCd;
    }

    public eachConfigEditor(callback: (editor: IOmnisharpTextEditor, cd: CompositeDisposable) => void): IDisposable {
        const outerCd = new CompositeDisposable();
        outerCd.add(this._configEditors.subscribe(editor => {
            const cd = new CompositeDisposable();
            outerCd.add(cd);
            editor.omnisharp.solution.disposable.add(cd);

            cd.add(editor.onDidDestroy((() => {
                editor.omnisharp.solution.disposable.remove(cd);
                outerCd.remove(cd);
                cd.dispose();
            })));

            callback(editor, cd);
        }));

        return outerCd;
    }

    public registerConfiguration(callback: (solution: Solution) => void) {
        SolutionManager.registerConfiguration(callback);
    }

    private get _kick_in_the_pants_() {
        return SolutionManager._kick_in_the_pants_;
    }

    public get grammars() {
        return filter(atom.grammars.getGrammars(),
            grammar => some(this._supportedExtensions,
                ext => some((<any>grammar).fileTypes,
                    ft => trimStart(ext, '.') === ft)));
    }

    public isValidGrammar(grammar: FirstMate.Grammar) {
        return some(this.grammars, { scopeName: (<any>grammar).scopeName });
    }

    public get packageDir() {
        if (!this._packageDir) {
            console.info(`getPackageDirPaths: ${atom.packages.getPackageDirPaths()}`);
            this._packageDir = find(atom.packages.getPackageDirPaths(), packagePath => {
                console.info(`packagePath ${packagePath} exists: ${fs.existsSync(path.join(packagePath, 'omnisharp-atom'))}`);
                return fs.existsSync(path.join(packagePath, 'omnisharp-atom'));
            });

            // Fallback, this is for unit testing on travis mainly
            if (!this._packageDir) {
                this._packageDir = path.resolve(__dirname, '../../..');
            }
        }
        return this._packageDir;
    }

    public get atomVersion() {
        if (!this._atomVersion) {
            this._atomVersion = new SemVer(<any>atom.getVersion());
        }
        return this._atomVersion;
    }

    public atomVersionGreaterThan(version: string) {
        return semverGt(<any>atom.getVersion(), version);
    }

    private _isOmniSharpEditor(editor: Atom.TextEditor) {
        return some(this._supportedExtensions, ext => endsWith(editor.getPath(), ext));
    }

    private _createTextEditorObservable(disposable: CompositeDisposable) {
        const safeGuard = this._createSafeGuard(this._supportedExtensions, disposable);

        const observeTextEditors = createObservable<Atom.TextEditor>(observer => {
            const dis = atom.workspace.observeTextEditors((editor: Atom.TextEditor) => {
                observer.next(editor);
            });

            return () => dis.dispose();
        }).share();

        this.disposable.add(
            Observable.merge(observeTextEditors.filter(x => !!x.getPath()), safeGuard)
                .mergeMap(editor => SolutionManager.getSolutionForEditor(editor), (editor, solution) => <IOmnisharpTextEditor>editor)
                .subscribe(),
            OmnisharpEditorContext.created
                .subscribe(editor => {
                    this._underlyingEditors.add(editor);
                    editor.omnisharp.config = endsWith(editor.getPath(), 'project.json');

                    const dis = Disposable.create(() => {
                        this._underlyingEditors.delete(editor);
                    });

                    this.disposable.add(
                        dis,
                        editor.onDidDestroy(() => dis.dispose())
                    );

                    editor.omnisharp.solution.disposable.add(dis);
                })
        );

        const liveEditors = OmnisharpEditorContext.created;
        return Observable.merge(
            Observable.defer(() => Observable.from<IOmnisharpTextEditor>(<any>this._underlyingEditors)),
            liveEditors
        );
    }

    private _createSafeGuard(extensions: string[], disposable: CompositeDisposable) {
        const editorSubject = new Subject<IOmnisharpTextEditor>();

        disposable.add(atom.workspace.observeActivePaneItem((pane: any) => editorSubject.next(pane)));
        const editorObservable = editorSubject.filter(z => z && !!z.getGrammar).startWith(null);

        return Observable.zip(editorObservable, editorObservable.skip(1), (editor, nextEditor) => ({ editor, nextEditor }))
            .debounceTime(50)
            .switchMap(({ nextEditor }) => {
                const path = nextEditor.getPath();
                if (!path) {
                    // editor isn"t saved yet.
                    if (nextEditor && this._isOmniSharpEditor(nextEditor)) {
                        atom.notifications.addInfo('OmniSharp', { detail: 'Functionality will limited until the file has been saved.' });
                    }

                    return new Promise<Atom.TextEditor>((resolve, reject) => {
                        const disposer = nextEditor.onDidChangePath(() => {
                            resolve(nextEditor);
                            disposer.dispose();
                        });
                    });
                }

                return Promise.resolve(null);
            })
            .filter(x => !!x);
    }
}

// tslint:disable-next-line:export-name variable-name
export const Omni = new OmniManager();
