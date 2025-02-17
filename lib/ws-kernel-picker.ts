import { Panel } from "atom";
import SelectListView from "atom-select-list";
import _ from "lodash";
import tildify from "tildify";
import { v4 } from "uuid";
import ws from "ws";
import { XMLHttpRequest as NodeXMLHttpRequest } from "@aminya/xmlhttprequest";
import { URL } from "url";
import { Kernel, Session, ServerConnection } from "@jupyterlab/services";
import Config from "./config";
import WSKernel from "./ws-kernel";
import InputView from "./input-view";
import store from "./store";
import type { KernelspecMetadata } from "@nteract/types";
import { setPreviouslyFocusedElement, DeepWriteable } from "./utils";

type SelectListItem = any;

export type KernelGatewayOptions = Parameters<
  typeof ServerConnection["makeSettings"]
>[0];

// Based on the config documentation
// TODO verify this
export type MinimalServerConnectionSettings = Pick<
  KernelGatewayOptions,
  "baseUrl"
>;

export interface KernelGateway {
  name: string;
  options: KernelGatewayOptions;
}

export interface SessionInfoWithModel {
  model: Kernel.IModel;
  options: Parameters<typeof Session.connectTo>[1];
}

export interface SessionInfoWithoutModel {
  name?: string;
  kernelSpecs: Kernel.ISpecModel[];
  options: Parameters<typeof Session.startNew>[0];
  // no model
  model?: never | null | undefined;
}

class CustomListView {
  onConfirmed: (item: SelectListItem) => void | null | undefined = null;
  onCancelled: () => void | null | undefined = null;
  previouslyFocusedElement: HTMLElement | null | undefined;
  selectListView: SelectListView;
  panel: Panel | null | undefined;

  constructor() {
    setPreviouslyFocusedElement(this);
    this.selectListView = new SelectListView({
      itemsClassList: ["mark-active"],
      items: [],
      filterKeyForItem: (item: SelectListItem) => item.name,
      elementForItem: (item: SelectListItem) => {
        const element = document.createElement("li");
        element.textContent = item.name;
        return element;
      },
      didConfirmSelection: (item: SelectListItem) => {
        if (this.onConfirmed) {
          this.onConfirmed(item);
        }
      },
      didCancelSelection: () => {
        this.cancel();
        if (this.onCancelled) {
          this.onCancelled();
        }
      },
    });
  }

  show() {
    if (!this.panel) {
      this.panel = atom.workspace.addModalPanel({
        item: this.selectListView,
      });
    }

    this.panel.show();
    this.selectListView.focus();
  }

  destroy() {
    this.cancel();
    return this.selectListView.destroy();
  }

  cancel() {
    if (this.panel != null) {
      this.panel.destroy();
    }

    this.panel = null;

    if (this.previouslyFocusedElement) {
      this.previouslyFocusedElement.focus();
      this.previouslyFocusedElement = null;
    }
  }
}

export default class WSKernelPicker {
  _onChosen: (kernel: WSKernel) => void;
  _kernelSpecFilter: (kernelSpec: Kernel.ISpecModel) => boolean;
  _path: string;
  listView: CustomListView;

  constructor(onChosen: (kernel: WSKernel) => void) {
    this._onChosen = onChosen;
    this.listView = new CustomListView();
  }

  async toggle(
    _kernelSpecFilter: (
      kernelSpec: Kernel.ISpecModel | KernelspecMetadata
    ) => boolean
  ) {
    setPreviouslyFocusedElement(this.listView);
    this._kernelSpecFilter = _kernelSpecFilter;
    const gateways = Config.getJson("gateways") || [];

    if (_.isEmpty(gateways)) {
      atom.notifications.addError("No remote kernel gateways available", {
        description:
          "Use the Hydrogen package settings to specify the list of remote servers. Hydrogen can use remote kernels on either a Jupyter Kernel Gateway or Jupyter notebook server.",
      });
      return;
    }

    this._path = `${store.filePath || "unsaved"}-${v4()}`;
    this.listView.onConfirmed = this.onGateway.bind(this);
    await this.listView.selectListView.update({
      items: gateways,
      infoMessage: "Select a gateway",
      emptyMessage: "No gateways available",
      loadingMessage: null,
    });
    this.listView.show();
  }

  async promptForText(prompt: string) {
    const previouslyFocusedElement = this.listView.previouslyFocusedElement;
    this.listView.cancel();
    const inputPromise = new Promise((resolve, reject) => {
      const inputView = new InputView(
        {
          prompt,
        },
        resolve
      );
      atom.commands.add(inputView.element, {
        "core:cancel": () => {
          inputView.close();
          reject();
        },
      });
      inputView.attach();
    });
    let response;

    try {
      response = await inputPromise;

      if (response === "") {
        return null;
      }
    } catch (e) {
      return null;
    }

    // Assume that no response to the prompt will cancel the entire flow, so
    // only restore listView if a response was received
    this.listView.show();
    this.listView.previouslyFocusedElement = previouslyFocusedElement;
    return response;
  }

  async promptForCookie(options: DeepWriteable<KernelGatewayOptions>) {
    const cookie = await this.promptForText("Cookie:");

    if (cookie === null) {
      return false;
    }

    if (options.requestHeaders === undefined) {
      options.requestHeaders = {};
    }

    options.requestHeaders.Cookie = cookie;

    options.xhrFactory = () => {
      const request = new NodeXMLHttpRequest();
      // Disable protections against setting the Cookie header
      request.setDisableHeaderCheck(true);
      return request as XMLHttpRequest; // TODO fix the types
    };

    options.wsFactory = (url, protocol) => {
      // Authentication requires requests to appear to be same-origin
      const parsedUrl = new URL(url);

      if (parsedUrl.protocol === "wss:") {
        parsedUrl.protocol = "https:";
      } else {
        parsedUrl.protocol = "http:";
      }

      const headers = {
        Cookie: cookie,
      };
      const origin = parsedUrl.origin;
      const host = parsedUrl.host;
      return new ws(url, protocol, {
        headers,
        origin,
        host,
      });
    };

    return true;
  }

  async promptForToken(options: DeepWriteable<KernelGatewayOptions>) {
    const token = await this.promptForText("Token:");

    if (token === null) {
      return false;
    }

    options.token = token;
    return true;
  }

  async promptForCredentials(options: DeepWriteable<KernelGatewayOptions>) {
    await this.listView.selectListView.update({
      items: [
        {
          name: "Authenticate with a token",
          action: "token",
        },
        {
          name: "Authenticate with a cookie",
          action: "cookie",
        },
        {
          name: "Cancel",
          action: "cancel",
        },
      ],
      infoMessage:
        "Connection to gateway failed. Your settings may be incorrect, the server may be unavailable, or you may lack sufficient privileges to complete the connection.",
      loadingMessage: null,
      emptyMessage: null,
    });
    const action = await new Promise((resolve, reject) => {
      this.listView.onConfirmed = (item) => resolve(item.action);

      this.listView.onCancelled = () => resolve("cancel");
    });

    if (action === "token") {
      return await this.promptForToken(options);
    }

    if (action === "cookie") {
      return await this.promptForCookie(options);
    }

    // action === "cancel"
    this.listView.cancel();
    return false;
  }

  async onGateway(gatewayInfo: KernelGateway) {
    this.listView.onConfirmed = null;
    await this.listView.selectListView.update({
      items: [],
      infoMessage: null,
      loadingMessage: "Loading sessions...",
      emptyMessage: "No sessions available",
    });
    const gatewayOptions = {
      xhrFactory: () => new NodeXMLHttpRequest() as XMLHttpRequest, // TODO fix the types
      wsFactory: (url, protocol) => new ws(url, protocol),
      ...gatewayInfo.options,
    };
    let serverSettings = ServerConnection.makeSettings(gatewayOptions);
    let specModels: Kernel.ISpecModels | undefined;
    try {
      specModels = await Kernel.getSpecs(serverSettings);
    } catch (error) {
      // The error types you get back at this stage are fairly opaque. In
      // particular, having invalid credentials typically triggers ECONNREFUSED
      // rather than 403 Forbidden. This does some basic checks and then assumes
      // that all remaining error types could be caused by invalid credentials.
      if (!error.xhr || !error.xhr.responseText) {
        throw error;
      } else if (error.xhr.responseText.includes("ETIMEDOUT")) {
        atom.notifications.addError("Connection to gateway failed");
        this.listView.cancel();
        return;
      } else {
        const promptSucceeded = await this.promptForCredentials(gatewayOptions);

        if (!promptSucceeded) {
          return;
        }

        serverSettings = ServerConnection.makeSettings(gatewayOptions);
        await this.listView.selectListView.update({
          items: [],
          infoMessage: null,
          loadingMessage: "Loading sessions...",
          emptyMessage: "No sessions available",
        });
      }
    }

    try {
      if (!specModels) {
        specModels = await Kernel.getSpecs(serverSettings);
      }

      const kernelSpecs = _.filter(specModels.kernelspecs, (spec) =>
        this._kernelSpecFilter(spec)
      );

      const kernelNames = _.map(kernelSpecs, (specModel) => specModel.name);

      try {
        let sessionModels = await Session.listRunning(serverSettings);
        sessionModels = sessionModels.filter((model) => {
          const name = model.kernel ? model.kernel.name : null;
          return name ? kernelNames.includes(name) : true;
        });
        const items = sessionModels.map((model) => {
          let name: string;

          if (model.path) {
            name = tildify(model.path);
          } else if (model.notebook?.path) {
            name = tildify(model.notebook!.path); // TODO fix the types
          } else {
            name = `Session ${model.id}`;
          }

          return {
            name,
            model,
            options: serverSettings,
          };
        });
        items.unshift({
          name: "[new session]",
          model: null,
          options: serverSettings,
          kernelSpecs,
        });
        this.listView.onConfirmed = this.onSession.bind(this, gatewayInfo.name);
        await this.listView.selectListView.update({
          items,
          loadingMessage: null,
        });
      } catch (error) {
        if (!error.xhr || error.xhr.status !== 403) {
          throw error;
        }
        // Gateways offer the option of never listing sessions, for security
        // reasons.
        // Assume this is the case and proceed to creating a new session.
        this.onSession(gatewayInfo.name, {
          name: "[new session]",
          model: null,
          options: serverSettings,
          kernelSpecs,
        });
      }
    } catch (e) {
      atom.notifications.addError("Connection to gateway failed");
      this.listView.cancel();
    }
  }

  onSession(
    gatewayName: string,
    sessionInfo: SessionInfoWithModel | SessionInfoWithoutModel
  ) {
    const model = sessionInfo.model;
    if (model === null || model === undefined) {
      // model not provided
      return this.onSessionWitouthModel(
        gatewayName,
        sessionInfo as SessionInfoWithoutModel
      );
    } else {
      // with model
      return this.onSessionWithModel(
        gatewayName,
        sessionInfo as SessionInfoWithModel
      );
    }
  }

  async onSessionWithModel(
    gatewayName: string,
    sessionInfo: SessionInfoWithModel
  ) {
    this.onSessionChosen(
      gatewayName,
      await Session.connectTo(sessionInfo.model.id, sessionInfo.options)
    );
  }

  async onSessionWitouthModel(
    gatewayName: string,
    sessionInfo: SessionInfoWithoutModel
  ) {
    if (!sessionInfo.name) {
      await this.listView.selectListView.update({
        items: [],
        errorMessage: "This gateway does not support listing sessions",
        loadingMessage: null,
        infoMessage: null,
      });
    }

    const items = _.map(sessionInfo.kernelSpecs, (spec) => {
      const options = {
        serverSettings: sessionInfo.options,
        kernelName: spec.name,
        path: this._path,
      };
      return {
        name: spec.display_name,
        options,
      };
    });

    this.listView.onConfirmed = this.startSession.bind(this, gatewayName);
    await this.listView.selectListView.update({
      items,
      emptyMessage: "No kernel specs available",
      infoMessage: "Select a session",
      loadingMessage: null,
    });
  }

  startSession(gatewayName: string, sessionInfo: SessionInfoWithoutModel) {
    Session.startNew(sessionInfo.options).then(
      this.onSessionChosen.bind(this, gatewayName)
    );
  }

  async onSessionChosen(gatewayName: string, session: Session.ISession) {
    this.listView.cancel();
    const kernelSpec = await session.kernel.getSpec();
    if (!store.grammar) {
      return;
    }
    const kernel = new WSKernel(
      gatewayName,
      kernelSpec,
      store.grammar,
      session
    );

    this._onChosen(kernel);
  }
}
