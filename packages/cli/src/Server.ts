import * as express from 'express';
import {
	readFileSync,
} from 'fs';
import {
	dirname as pathDirname,
	join as pathJoin,
	resolve as pathResolve,
} from 'path';
import {
	getConnectionManager,
} from 'typeorm';
import * as bodyParser from 'body-parser';
require('body-parser-xml')(bodyParser);
import * as history from 'connect-history-api-fallback';
import * as _ from 'lodash';
import * as clientOAuth2 from 'client-oauth2';
import * as clientOAuth1 from 'oauth-1.0a';
import { RequestOptions } from 'oauth-1.0a';
import * as csrf from 'csrf';
import * as requestPromise from 'request-promise-native';
import { createHmac } from 'crypto';
import { compare } from 'bcrypt';

import {
	ActiveExecutions,
	ActiveWorkflowRunner,
	CredentialsHelper,
	CredentialTypes,
	Db,
	ExternalHooks,
	IActivationError,
	ICustomRequest,
	ICredentialsDb,
	ICredentialsDecryptedDb,
	ICredentialsDecryptedResponse,
	ICredentialsResponse,
	IExecutionDeleteFilter,
	IExecutionFlatted,
	IExecutionFlattedDb,
	IExecutionFlattedResponse,
	IExecutionPushResponse,
	IExecutionsListResponse,
	IExecutionsStopData,
	IExecutionsSummary,
	IExternalHooksClass,
	IN8nUISettings,
	IPackageVersions,
	IWorkflowBase,
	IWorkflowShortResponse,
	IWorkflowResponse,
	IWorkflowExecutionDataProcess,
	NodeTypes,
	Push,
	ResponseHelper,
	TestWebhooks,
	WorkflowCredentials,
	WebhookHelpers,
	WorkflowExecuteAdditionalData,
	WorkflowRunner,
	GenericHelpers,
	CredentialsOverwrites,
	ICredentialsOverwrite,
	LoadNodesAndCredentials,
} from './';

import {
	Credentials,
	LoadNodeParameterOptions,
	UserSettings,
} from 'n8n-core';

import {
	ICredentialsEncrypted,
	ICredentialType,
	IDataObject,
	INodeCredentials,
	INodeTypeDescription,
	INodeParameters,
	INodePropertyOptions,
	IRunData,
	IWorkflowCredentials,
	Workflow,
} from 'n8n-workflow';

import {
	FindManyOptions,
	FindOneOptions,
	LessThan,
	LessThanOrEqual,
	Not,
} from 'typeorm';

import * as basicAuth from 'basic-auth';
import * as compression from 'compression';
import * as config from '../config';
import * as jwt from 'jsonwebtoken';
import * as jwks from 'jwks-rsa';
// @ts-ignore
import * as timezones from 'google-timezones-json';
import * as parseUrl from 'parseurl';
import * as querystring from 'querystring';
import { OptionsWithUrl } from 'request-promise-native';

class App {

	app: express.Application;
	activeWorkflowRunner: ActiveWorkflowRunner.ActiveWorkflowRunner;
	testWebhooks: TestWebhooks.TestWebhooks;
	endpointWebhook: string;
	endpointWebhookTest: string;
	endpointPresetCredentials: string;
	externalHooks: IExternalHooksClass;
	saveDataErrorExecution: string;
	saveDataSuccessExecution: string;
	saveManualExecutions: boolean;
	executionTimeout: number;
	maxExecutionTimeout: number;
	timezone: string;
	activeExecutionsInstance: ActiveExecutions.ActiveExecutions;
	push: Push.Push;
	versions: IPackageVersions | undefined;
	restEndpoint: string;

	protocol: string;
	sslKey: string;
	sslCert: string;

	presetCredentialsLoaded: boolean;

	constructor() {
		this.app = express();

		this.endpointWebhook = config.get('endpoints.webhook') as string;
		this.endpointWebhookTest = config.get('endpoints.webhookTest') as string;
		this.saveDataErrorExecution = config.get('executions.saveDataOnError') as string;
		this.saveDataSuccessExecution = config.get('executions.saveDataOnSuccess') as string;
		this.saveManualExecutions = config.get('executions.saveDataManualExecutions') as boolean;
		this.executionTimeout = config.get('executions.timeout') as number;
		this.maxExecutionTimeout = config.get('executions.maxTimeout') as number;
		this.timezone = config.get('generic.timezone') as string;
		this.restEndpoint = config.get('endpoints.rest') as string;

		this.activeWorkflowRunner = ActiveWorkflowRunner.getInstance();
		this.testWebhooks = TestWebhooks.getInstance();
		this.push = Push.getInstance();

		this.activeExecutionsInstance = ActiveExecutions.getInstance();

		this.protocol = config.get('protocol');
		this.sslKey = config.get('ssl_key');
		this.sslCert = config.get('ssl_cert');

		this.externalHooks = ExternalHooks();

		this.presetCredentialsLoaded = false;
		this.endpointPresetCredentials = config.get('credentials.overwrite.endpoint') as string;
	}


	/**
	 * Returns the current epoch time
	 *
	 * @returns {number}
	 * @memberof App
	 */
	getCurrentDate(): Date {
		return new Date();
	}


	async config(): Promise<void> {

		this.versions = await GenericHelpers.getVersions();
		const ignoredEndpoints = _(['healthz', this.endpointWebhook, this.endpointWebhookTest, this.endpointPresetCredentials]).compact().join('|');
		const authIgnoreRegex = new RegExp(`^\/(${ignoredEndpoints})\/?.*$`);

		// Check for basic auth credentials if activated
		const basicAuthActive = config.get('security.basicAuth.active') as boolean;
		if (basicAuthActive === true) {
			const basicAuthUser = await GenericHelpers.getConfigValue('security.basicAuth.user') as string;
			if (basicAuthUser === '') {
				throw new Error('Basic auth is activated but no user got defined. Please set one!');
			}

			const basicAuthPassword = await GenericHelpers.getConfigValue('security.basicAuth.password') as string;
			if (basicAuthPassword === '') {
				throw new Error('Basic auth is activated but no password got defined. Please set one!');
			}

			const basicAuthHashEnabled = await GenericHelpers.getConfigValue('security.basicAuth.hash') as boolean;

			let validPassword: null | string = null;

			this.app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
				if (req.url.match(authIgnoreRegex)) {
					return next();
				}
				const realm = 'n8n - Editor UI';
				const basicAuthData = basicAuth(req);

				if (basicAuthData === undefined) {
					// Authorization data is missing
					return ResponseHelper.basicAuthAuthorizationError(res, realm, 'Authorization is required!');
				}

				if (basicAuthData.name === basicAuthUser) {
					if (basicAuthHashEnabled === true) {
						if (validPassword === null && await compare(basicAuthData.pass, basicAuthPassword)) {
							// Password is valid so save for future requests
							validPassword = basicAuthData.pass;
						}

						if (validPassword === basicAuthData.pass && validPassword !== null) {
							// Provided hash is correct
							return next();
						}
					} else {
						if (basicAuthData.pass === basicAuthPassword) {
							// Provided password is correct
							return next();
						}
					}
				}

				// Provided authentication data is wrong
				return ResponseHelper.basicAuthAuthorizationError(res, realm, 'Authorization data is wrong!');
			});
		}

		// Check for and validate JWT if configured
		const jwtAuthActive = config.get('security.jwtAuth.active') as boolean;
		if (jwtAuthActive === true) {
			const jwtAuthHeader = await GenericHelpers.getConfigValue('security.jwtAuth.jwtHeader') as string;
			if (jwtAuthHeader === '') {
				throw new Error('JWT auth is activated but no request header was defined. Please set one!');
			}
			const jwksUri = await GenericHelpers.getConfigValue('security.jwtAuth.jwksUri') as string;
			if (jwksUri === '') {
				throw new Error('JWT auth is activated but no JWK Set URI was defined. Please set one!');
			}
			const jwtHeaderValuePrefix = await GenericHelpers.getConfigValue('security.jwtAuth.jwtHeaderValuePrefix') as string;
			const jwtIssuer = await GenericHelpers.getConfigValue('security.jwtAuth.jwtIssuer') as string;
			const jwtNamespace = await GenericHelpers.getConfigValue('security.jwtAuth.jwtNamespace') as string;
			const jwtAllowedTenantKey = await GenericHelpers.getConfigValue('security.jwtAuth.jwtAllowedTenantKey') as string;
			const jwtAllowedTenant = await GenericHelpers.getConfigValue('security.jwtAuth.jwtAllowedTenant') as string;

			function isTenantAllowed(decodedToken: object): boolean {
				if (jwtNamespace === '' || jwtAllowedTenantKey === '' || jwtAllowedTenant === '') return true;
				else {
					for (const [k, v] of Object.entries(decodedToken)) {
						if (k === jwtNamespace) {
							for (const [kn, kv] of Object.entries(v)) {
								if (kn === jwtAllowedTenantKey && kv === jwtAllowedTenant) {
									return true;
								}
							}
						}
					}
				}
				return false;
			}

			this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
				if (req.url.match(authIgnoreRegex)) {
					return next();
				}

				let token = req.header(jwtAuthHeader) as string;
				if (token === undefined || token === '') {
					return ResponseHelper.jwtAuthAuthorizationError(res, "Missing token");
				}
				if (jwtHeaderValuePrefix !== '' && token.startsWith(jwtHeaderValuePrefix)) {
					token = token.replace(jwtHeaderValuePrefix + ' ', '').trimLeft();
				}

				const jwkClient = jwks({ cache: true, jwksUri });
				function getKey(header: any, callback: Function) { // tslint:disable-line:no-any
					jwkClient.getSigningKey(header.kid, (err: Error, key: any) => { // tslint:disable-line:no-any
						if (err) throw ResponseHelper.jwtAuthAuthorizationError(res, err.message);

						const signingKey = key.publicKey || key.rsaPublicKey;
						callback(null, signingKey);
					});
				}

				const jwtVerifyOptions: jwt.VerifyOptions = {
					issuer: jwtIssuer !== '' ? jwtIssuer : undefined,
					ignoreExpiration: false
				};

				jwt.verify(token, getKey, jwtVerifyOptions, (err: jwt.VerifyErrors, decoded: object) => {
					if (err) ResponseHelper.jwtAuthAuthorizationError(res, 'Invalid token');
					else if (!isTenantAllowed(decoded)) ResponseHelper.jwtAuthAuthorizationError(res, 'Tenant not allowed');
					else next();
				});
			});
		}

		// Get push connections
		this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
			if (req.url.indexOf(`/${this.restEndpoint}/push`) === 0) {
				// TODO: Later also has to add some kind of authentication token
				if (req.query.sessionId === undefined) {
					next(new Error('The query parameter "sessionId" is missing!'));
					return;
				}

				this.push.add(req.query.sessionId as string, req, res);
				return;
			}
			next();
		});

		// Compress the response data
		this.app.use(compression());

		// Make sure that each request has the "parsedUrl" parameter
		this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
			(req as ICustomRequest).parsedUrl = parseUrl(req);
			// @ts-ignore
			req.rawBody = Buffer.from('', 'base64');
			next();
		});

		// Support application/json type post data
		this.app.use(bodyParser.json({
			limit: '16mb', verify: (req, res, buf) => {
				// @ts-ignore
				req.rawBody = buf;
			}
		}));

		// Support application/xml type post data
		// @ts-ignore
		this.app.use(bodyParser.xml({
			limit: '16mb', xmlParseOptions: {
				normalize: true,     // Trim whitespace inside text nodes
				normalizeTags: true, // Transform tags to lowercase
				explicitArray: false, // Only put properties in array if length > 1
			}
		}));

		this.app.use(bodyParser.text({
			limit: '16mb', verify: (req, res, buf) => {
				// @ts-ignore
				req.rawBody = buf;
			}
		}));

		// Make sure that Vue history mode works properly
		this.app.use(history({
			rewrites: [
				{
					from: new RegExp(`^\/(${this.restEndpoint}|healthz|css|js|${this.endpointWebhook}|${this.endpointWebhookTest})\/?.*$`),
					to: (context) => {
						return context.parsedUrl!.pathname!.toString();
					}
				}
			]
		}));

		//support application/x-www-form-urlencoded post data
		this.app.use(bodyParser.urlencoded({ extended: false,
			verify: (req, res, buf) => {
				// @ts-ignore
				req.rawBody = buf;
			}
		}));

		if (process.env['NODE_ENV'] !== 'production') {
			this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
				// Allow access also from frontend when developing
				res.header('Access-Control-Allow-Origin', 'http://localhost:8080');
				res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
				res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, sessionid');
				next();
			});
		}


		this.app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
			if (Db.collections.Workflow === null) {
				const error = new ResponseHelper.ResponseError('Database is not ready!', undefined, 503);
				return ResponseHelper.sendErrorResponse(res, error);
			}

			next();
		});



		// ----------------------------------------
		// Healthcheck
		// ----------------------------------------


		// Does very basic health check
		this.app.get('/healthz', async (req: express.Request, res: express.Response) => {

			const connectionManager = getConnectionManager();

			if (connectionManager.connections.length === 0) {
				const error = new ResponseHelper.ResponseError('No Database connection found!', undefined, 503);
				return ResponseHelper.sendErrorResponse(res, error);
			}

			if (connectionManager.connections[0].isConnected === false) {
				// Connection is not active
				const error = new ResponseHelper.ResponseError('Database connection not active!', undefined, 503);
				return ResponseHelper.sendErrorResponse(res, error);
			}

			// Everything fine
			const responseData = {
				status: 'ok',
			};

			ResponseHelper.sendSuccessResponse(res, responseData, true, 200);
		});



		// ----------------------------------------
		// Workflow
		// ----------------------------------------


		// Creates a new workflow
		this.app.post(`/${this.restEndpoint}/workflows`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IWorkflowResponse> => {

			const newWorkflowData = req.body as IWorkflowBase;

			newWorkflowData.name = newWorkflowData.name.trim();
			newWorkflowData.createdAt = this.getCurrentDate();
			newWorkflowData.updatedAt = this.getCurrentDate();

			newWorkflowData.id = undefined;

			await this.externalHooks.run('workflow.create', [newWorkflowData]);

			// Save the workflow in DB
			const result = await Db.collections.Workflow!.save(newWorkflowData);

			// Convert to response format in which the id is a string
			(result as IWorkflowBase as IWorkflowResponse).id = result.id.toString();
			return result as IWorkflowBase as IWorkflowResponse;

		}));


		// Reads and returns workflow data from an URL
		this.app.get(`/${this.restEndpoint}/workflows/from-url`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IWorkflowResponse> => {
			if (req.query.url === undefined) {
				throw new ResponseHelper.ResponseError(`The parameter "url" is missing!`, undefined, 400);
			}
			if (!(req.query.url as string).match(/^http[s]?:\/\/.*\.json$/i)) {
				throw new ResponseHelper.ResponseError(`The parameter "url" is not valid! It does not seem to be a URL pointing to a n8n workflow JSON file.`, undefined, 400);
			}
			const data = await requestPromise.get(req.query.url as string);

			let workflowData: IWorkflowResponse | undefined;
			try {
				workflowData = JSON.parse(data);
			} catch (error) {
				throw new ResponseHelper.ResponseError(`The URL does not point to valid JSON file!`, undefined, 400);
			}

			// Do a very basic check if it is really a n8n-workflow-json
			if (workflowData === undefined || workflowData.nodes === undefined || !Array.isArray(workflowData.nodes) ||
				workflowData.connections === undefined || typeof workflowData.connections !== 'object' ||
				Array.isArray(workflowData.connections)) {
				throw new ResponseHelper.ResponseError(`The data in the file does not seem to be a n8n workflow JSON file!`, undefined, 400);
			}

			return workflowData;
		}));


		// Returns workflows
		this.app.get(`/${this.restEndpoint}/workflows`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IWorkflowShortResponse[]> => {
			const findQuery = {} as FindManyOptions;
			if (req.query.filter) {
				findQuery.where = JSON.parse(req.query.filter as string);
			}

			// Return only the fields we need
			findQuery.select = ['id', 'name', 'active', 'createdAt', 'updatedAt'];

			const results = await Db.collections.Workflow!.find(findQuery);

			for (const entry of results) {
				(entry as unknown as IWorkflowShortResponse).id = entry.id.toString();
			}

			return results as unknown as IWorkflowShortResponse[];
		}));


		// Returns a specific workflow
		this.app.get(`/${this.restEndpoint}/workflows/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IWorkflowResponse | undefined> => {
			const result = await Db.collections.Workflow!.findOne(req.params.id);

			if (result === undefined) {
				return undefined;
			}

			// Convert to response format in which the id is a string
			(result as IWorkflowBase as IWorkflowResponse).id = result.id.toString();
			return result as IWorkflowBase as IWorkflowResponse;
		}));


		// Updates an existing workflow
		this.app.patch(`/${this.restEndpoint}/workflows/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IWorkflowResponse> => {

			const newWorkflowData = req.body as IWorkflowBase;
			const id = req.params.id;

			await this.externalHooks.run('workflow.update', [newWorkflowData]);

			const isActive = await this.activeWorkflowRunner.isActive(id);

			if (isActive) {
				// When workflow gets saved always remove it as the triggers could have been
				// changed and so the changes would not take effect
				await this.activeWorkflowRunner.remove(id);
			}

			if (newWorkflowData.settings) {
				if (newWorkflowData.settings.timezone === 'DEFAULT') {
					// Do not save the default timezone
					delete newWorkflowData.settings.timezone;
				}
				if (newWorkflowData.settings.saveDataErrorExecution === 'DEFAULT') {
					// Do not save when default got set
					delete newWorkflowData.settings.saveDataErrorExecution;
				}
				if (newWorkflowData.settings.saveDataSuccessExecution === 'DEFAULT') {
					// Do not save when default got set
					delete newWorkflowData.settings.saveDataSuccessExecution;
				}
				if (newWorkflowData.settings.saveManualExecutions === 'DEFAULT') {
					// Do not save when default got set
					delete newWorkflowData.settings.saveManualExecutions;
				}
				if (parseInt(newWorkflowData.settings.executionTimeout as string, 10) === this.executionTimeout) {
					// Do not save when default got set
					delete newWorkflowData.settings.executionTimeout;
				}
			}

			newWorkflowData.updatedAt = this.getCurrentDate();

			await Db.collections.Workflow!.update(id, newWorkflowData);

			// We sadly get nothing back from "update". Neither if it updated a record
			// nor the new value. So query now the hopefully updated entry.
			const responseData = await Db.collections.Workflow!.findOne(id);

			if (responseData === undefined) {
				throw new ResponseHelper.ResponseError(`Workflow with id "${id}" could not be found to be updated.`, undefined, 400);
			}

			if (responseData.active === true) {
				// When the workflow is supposed to be active add it again
				try {
					await this.externalHooks.run('workflow.activate', [responseData]);

					await this.activeWorkflowRunner.add(id);
				} catch (error) {
					// If workflow could not be activated set it again to inactive
					newWorkflowData.active = false;
					await Db.collections.Workflow!.update(id, newWorkflowData);

					// Also set it in the returned data
					responseData.active = false;

					// Now return the original error for UI to display
					throw error;
				}
			}

			// Convert to response format in which the id is a string
			(responseData as IWorkflowBase as IWorkflowResponse).id = responseData.id.toString();
			return responseData as IWorkflowBase as IWorkflowResponse;
		}));


		// Deletes a specific workflow
		this.app.delete(`/${this.restEndpoint}/workflows/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<boolean> => {
			const id = req.params.id;

			await this.externalHooks.run('workflow.delete', [id]);

			const isActive = await this.activeWorkflowRunner.isActive(id);

			if (isActive) {
				// Before deleting a workflow deactivate it
				await this.activeWorkflowRunner.remove(id);
			}

			await Db.collections.Workflow!.delete(id);

			return true;
		}));


		this.app.post(`/${this.restEndpoint}/workflows/run`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IExecutionPushResponse> => {
			const workflowData = req.body.workflowData;
			const runData: IRunData | undefined = req.body.runData;
			const startNodes: string[] | undefined = req.body.startNodes;
			const destinationNode: string | undefined = req.body.destinationNode;
			const executionMode = 'manual';

			const sessionId = GenericHelpers.getSessionId(req);

			// If webhooks nodes exist and are active we have to wait for till we receive a call
			if (runData === undefined || startNodes === undefined || startNodes.length === 0 || destinationNode === undefined) {
				const credentials = await WorkflowCredentials(workflowData.nodes);
				const additionalData = await WorkflowExecuteAdditionalData.getBase(credentials);
				const nodeTypes = NodeTypes();
				const workflowInstance = new Workflow({ id: workflowData.id, name: workflowData.name, nodes: workflowData.nodes, connections: workflowData.connections, active: false, nodeTypes, staticData: undefined, settings: workflowData.settings });
				const needsWebhook = await this.testWebhooks.needsWebhookData(workflowData, workflowInstance, additionalData, executionMode, sessionId, destinationNode);
				if (needsWebhook === true) {
					return {
						waitingForWebhook: true,
					};
				}
			}

			// For manual testing always set to not active
			workflowData.active = false;

			const credentials = await WorkflowCredentials(workflowData.nodes);

			// Start the workflow
			const data: IWorkflowExecutionDataProcess = {
				credentials,
				destinationNode,
				executionMode,
				runData,
				sessionId,
				startNodes,
				workflowData,
			};
			const workflowRunner = new WorkflowRunner();
			const executionId = await workflowRunner.run(data);

			return {
				executionId,
			};
		}));


		// Returns parameter values which normally get loaded from an external API or
		// get generated dynamically
		this.app.get(`/${this.restEndpoint}/node-parameter-options`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<INodePropertyOptions[]> => {
			const nodeType = req.query.nodeType as string;
			let credentials: INodeCredentials | undefined = undefined;
			const currentNodeParameters = JSON.parse('' + req.query.currentNodeParameters) as INodeParameters;
			if (req.query.credentials !== undefined) {
				credentials = JSON.parse(req.query.credentials as string);
			}
			const methodName = req.query.methodName as string;

			const nodeTypes = NodeTypes();

			const loadDataInstance = new LoadNodeParameterOptions(nodeType, nodeTypes, JSON.parse('' + req.query.currentNodeParameters), credentials!);

			const workflowData = loadDataInstance.getWorkflowData() as IWorkflowBase;
			const workflowCredentials = await WorkflowCredentials(workflowData.nodes);
			const additionalData = await WorkflowExecuteAdditionalData.getBase(workflowCredentials, currentNodeParameters);

			return loadDataInstance.getOptions(methodName, additionalData);
		}));


		// Returns all the node-types
		this.app.get(`/${this.restEndpoint}/node-types`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<INodeTypeDescription[]> => {

			const returnData: INodeTypeDescription[] = [];

			const nodeTypes = NodeTypes();

			const allNodes = nodeTypes.getAll();

			allNodes.forEach((nodeData) => {
				returnData.push(nodeData.description);
			});

			return returnData;
		}));



		// ----------------------------------------
		// Node-Types
		// ----------------------------------------


		// Returns the node icon
		this.app.get([`/${this.restEndpoint}/node-icon/:nodeType`, `/${this.restEndpoint}/node-icon/:scope/:nodeType`], async (req: express.Request, res: express.Response): Promise<void> => {
			const nodeTypeName = `${req.params.scope ? `${req.params.scope}/` : ''}${req.params.nodeType}`;

			const nodeTypes = NodeTypes();
			const nodeType = nodeTypes.getByName(nodeTypeName);

			if (nodeType === undefined) {
				res.status(404).send('The nodeType is not known.');
				return;
			}

			if (nodeType.description.icon === undefined) {
				res.status(404).send('No icon found for node.');
				return;
			}

			if (!nodeType.description.icon.startsWith('file:')) {
				res.status(404).send('Node does not have a file icon.');
				return;
			}

			const filepath = nodeType.description.icon.substr(5);

			res.sendFile(filepath);
		});



		// ----------------------------------------
		// Active Workflows
		// ----------------------------------------


		// Returns the active workflow ids
		this.app.get(`/${this.restEndpoint}/active`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<string[]> => {
			const activeWorkflows = await this.activeWorkflowRunner.getActiveWorkflows();
			return activeWorkflows.map(workflow => workflow.id.toString()) as string[];
		}));


		// Returns if the workflow with the given id had any activation errors
		this.app.get(`/${this.restEndpoint}/active/error/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IActivationError | undefined> => {
			const id = req.params.id;
			return this.activeWorkflowRunner.getActivationError(id);
		}));



		// ----------------------------------------
		// Credentials
		// ----------------------------------------


		// Deletes a specific credential
		this.app.delete(`/${this.restEndpoint}/credentials/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<boolean> => {
			const id = req.params.id;

			await this.externalHooks.run('credentials.delete', [id]);

			await Db.collections.Credentials!.delete({ id });

			return true;
		}));

		// Creates new credentials
		this.app.post(`/${this.restEndpoint}/credentials`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<ICredentialsResponse> => {
			const incomingData = req.body;

			if (!incomingData.name || incomingData.name.length < 3) {
				throw new ResponseHelper.ResponseError(`Credentials name must be at least 3 characters long.`, undefined, 400);
			}

			// Add the added date for node access permissions
			for (const nodeAccess of incomingData.nodesAccess) {
				nodeAccess.date = this.getCurrentDate();
			}

			const encryptionKey = await UserSettings.getEncryptionKey();
			if (encryptionKey === undefined) {
				throw new Error('No encryption key got found to encrypt the credentials!');
			}

			if (incomingData.name === '') {
				throw new Error('Credentials have to have a name set!');
			}

			// Check if credentials with the same name and type exist already
			const findQuery = {
				where: {
					name: incomingData.name,
					type: incomingData.type,
				},
			} as FindOneOptions;

			const checkResult = await Db.collections.Credentials!.findOne(findQuery);
			if (checkResult !== undefined) {
				throw new ResponseHelper.ResponseError(`Credentials with the same type and name exist already.`, undefined, 400);
			}

			// Encrypt the data
			const credentials = new Credentials(incomingData.name, incomingData.type, incomingData.nodesAccess);
			credentials.setData(incomingData.data, encryptionKey);
			const newCredentialsData = credentials.getDataToSave() as ICredentialsDb;

			await this.externalHooks.run('credentials.create', [newCredentialsData]);

			// Add special database related data
			newCredentialsData.createdAt = this.getCurrentDate();
			newCredentialsData.updatedAt = this.getCurrentDate();

			// TODO: also add user automatically depending on who is logged in, if anybody is logged in

			// Save the credentials in DB
			const result = await Db.collections.Credentials!.save(newCredentialsData);
			result.data = incomingData.data;

			// Convert to response format in which the id is a string
			(result as unknown as ICredentialsResponse).id = result.id.toString();
			return result as unknown as ICredentialsResponse;
		}));


		// Updates existing credentials
		this.app.patch(`/${this.restEndpoint}/credentials/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<ICredentialsResponse> => {
			const incomingData = req.body;

			const id = req.params.id;

			if (incomingData.name === '') {
				throw new Error('Credentials have to have a name set!');
			}

			// Add the date for newly added node access permissions
			for (const nodeAccess of incomingData.nodesAccess) {
				if (!nodeAccess.date) {
					nodeAccess.date = this.getCurrentDate();
				}
			}

			// Check if credentials with the same name and type exist already
			const findQuery = {
				where: {
					id: Not(id),
					name: incomingData.name,
					type: incomingData.type,
				},
			} as FindOneOptions;

			const checkResult = await Db.collections.Credentials!.findOne(findQuery);
			if (checkResult !== undefined) {
				throw new ResponseHelper.ResponseError(`Credentials with the same type and name exist already.`, undefined, 400);
			}

			const encryptionKey = await UserSettings.getEncryptionKey();
			if (encryptionKey === undefined) {
				throw new Error('No encryption key got found to encrypt the credentials!');
			}

			// Load the currently saved credentials to be able to persist some of the data if
			const result = await Db.collections.Credentials!.findOne(id);
			if (result === undefined) {
				throw new ResponseHelper.ResponseError(`Credentials with the id "${id}" do not exist.`, undefined, 400);
			}

			const currentlySavedCredentials = new Credentials(result.name, result.type, result.nodesAccess, result.data);
			const decryptedData = currentlySavedCredentials.getData(encryptionKey!);

			// Do not overwrite the oauth data else data like the access or refresh token would get lost
			// everytime anybody changes anything on the credentials even if it is just the name.
			if (decryptedData.oauthTokenData) {
				incomingData.data.oauthTokenData = decryptedData.oauthTokenData;
			}

			// Encrypt the data
			const credentials = new Credentials(incomingData.name, incomingData.type, incomingData.nodesAccess);
			credentials.setData(incomingData.data, encryptionKey);
			const newCredentialsData = credentials.getDataToSave() as unknown as ICredentialsDb;

			// Add special database related data
			newCredentialsData.updatedAt = this.getCurrentDate();

			await this.externalHooks.run('credentials.update', [newCredentialsData]);

			// Update the credentials in DB
			await Db.collections.Credentials!.update(id, newCredentialsData);

			// We sadly get nothing back from "update". Neither if it updated a record
			// nor the new value. So query now the hopefully updated entry.
			const responseData = await Db.collections.Credentials!.findOne(id);

			if (responseData === undefined) {
				throw new ResponseHelper.ResponseError(`Credentials with id "${id}" could not be found to be updated.`, undefined, 400);
			}

			// Remove the encrypted data as it is not needed in the frontend
			responseData.data = '';

			// Convert to response format in which the id is a string
			(responseData as unknown as ICredentialsResponse).id = responseData.id.toString();
			return responseData as unknown as ICredentialsResponse;
		}));


		// Returns specific credentials
		this.app.get(`/${this.restEndpoint}/credentials/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<ICredentialsDecryptedResponse | ICredentialsResponse | undefined> => {
			const findQuery = {} as FindManyOptions;

			// Make sure the variable has an expected value
			const includeData = ['true', true].includes(req.query.includeData as string);

			if (includeData !== true) {
				// Return only the fields we need
				findQuery.select = ['id', 'name', 'type', 'nodesAccess', 'createdAt', 'updatedAt'];
			}

			const result = await Db.collections.Credentials!.findOne(req.params.id);

			if (result === undefined) {
				return result;
			}

			let encryptionKey = undefined;
			if (includeData === true) {
				encryptionKey = await UserSettings.getEncryptionKey();
				if (encryptionKey === undefined) {
					throw new Error('No encryption key got found to decrypt the credentials!');
				}

				const credentials = new Credentials(result.name, result.type, result.nodesAccess, result.data);
				(result as ICredentialsDecryptedDb).data = credentials.getData(encryptionKey!);
			}

			(result as ICredentialsDecryptedResponse).id = result.id.toString();

			return result as ICredentialsDecryptedResponse;
		}));


		// Returns all the saved credentials
		this.app.get(`/${this.restEndpoint}/credentials`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<ICredentialsResponse[]> => {
			const findQuery = {} as FindManyOptions;
			if (req.query.filter) {
				findQuery.where = JSON.parse(req.query.filter as string);
				if ((findQuery.where! as IDataObject).id !== undefined) {
					// No idea if multiple where parameters make db search
					// slower but to be sure that that is not the case we
					// remove all unnecessary fields in case the id is defined.
					findQuery.where = { id: (findQuery.where! as IDataObject).id };
				}
			}

			findQuery.select = ['id', 'name', 'type', 'nodesAccess', 'createdAt', 'updatedAt'];

			const results = await Db.collections.Credentials!.find(findQuery) as unknown as ICredentialsResponse[];

			let encryptionKey = undefined;

			const includeData = ['true', true].includes(req.query.includeData as string);
			if (includeData === true) {
				encryptionKey = await UserSettings.getEncryptionKey();
				if (encryptionKey === undefined) {
					throw new Error('No encryption key got found to decrypt the credentials!');
				}
			}

			let result;
			for (result of results) {
				(result as ICredentialsDecryptedResponse).id = result.id.toString();
			}

			return results;
		}));



		// ----------------------------------------
		// Credential-Types
		// ----------------------------------------


		// Returns all the credential types which are defined in the loaded n8n-modules
		this.app.get(`/${this.restEndpoint}/credential-types`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<ICredentialType[]> => {

			const returnData: ICredentialType[] = [];

			const credentialTypes = CredentialTypes();

			credentialTypes.getAll().forEach((credentialData) => {
				returnData.push(credentialData);
			});

			return returnData;
		}));

		// ----------------------------------------
		// OAuth1-Credential/Auth
		// ----------------------------------------

		// Authorize OAuth Data
		this.app.get(`/${this.restEndpoint}/oauth1-credential/auth`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<string> => {
			if (req.query.id === undefined) {
				res.status(500).send('Required credential id is missing!');
				return '';
			}

			const result = await Db.collections.Credentials!.findOne(req.query.id as string);
			if (result === undefined) {
				res.status(404).send('The credential is not known.');
				return '';
			}

			let encryptionKey = undefined;
			encryptionKey = await UserSettings.getEncryptionKey();
			if (encryptionKey === undefined) {
				res.status(500).send('No encryption key got found to decrypt the credentials!');
				return '';
			}

			// Decrypt the currently saved credentials
			const workflowCredentials: IWorkflowCredentials = {
				[result.type as string]: {
					[result.name as string]: result as ICredentialsEncrypted,
				},
			};
			const credentialsHelper = new CredentialsHelper(workflowCredentials, encryptionKey);
			const decryptedDataOriginal = credentialsHelper.getDecrypted(result.name, result.type, true);
			const oauthCredentials = credentialsHelper.applyDefaultsAndOverwrites(decryptedDataOriginal, result.type);

			const signatureMethod = _.get(oauthCredentials, 'signatureMethod') as string;

			const oAuthOptions: clientOAuth1.Options = {
				consumer: {
					key: _.get(oauthCredentials, 'consumerKey') as string,
					secret: _.get(oauthCredentials, 'consumerSecret') as string,
				},
				signature_method: signatureMethod,
				hash_function(base, key) {
					const algorithm = (signatureMethod === 'HMAC-SHA1') ? 'sha1' : 'sha256';
					return createHmac(algorithm, key)
						.update(base)
						.digest('base64');
				},
			};

			const oauthRequestData = {
				oauth_callback: `${WebhookHelpers.getWebhookBaseUrl()}${this.restEndpoint}/oauth1-credential/callback?cid=${req.query.id}`
			};

			await this.externalHooks.run('oauth1.authenticate', [oAuthOptions, oauthRequestData]);

			const oauth = new clientOAuth1(oAuthOptions);

			const options: RequestOptions = {
				method: 'POST',
				url: (_.get(oauthCredentials, 'requestTokenUrl') as string),
				data: oauthRequestData,
			};

			const data = oauth.toHeader(oauth.authorize(options as RequestOptions));

			//@ts-ignore
			options.headers = data;

			const response = await requestPromise(options);

			// Response comes as x-www-form-urlencoded string so convert it to JSON

			const responseJson = querystring.parse(response);

			const returnUri = `${_.get(oauthCredentials, 'authUrl')}?oauth_token=${responseJson.oauth_token}`;

			// Encrypt the data
			const credentials = new Credentials(result.name, result.type, result.nodesAccess);

			credentials.setData(decryptedDataOriginal, encryptionKey);
			const newCredentialsData = credentials.getDataToSave() as unknown as ICredentialsDb;

			// Add special database related data
			newCredentialsData.updatedAt = this.getCurrentDate();

			// Update the credentials in DB
			await Db.collections.Credentials!.update(req.query.id as string, newCredentialsData);

			return returnUri;
		}));

		// Verify and store app code. Generate access tokens and store for respective credential.
		this.app.get(`/${this.restEndpoint}/oauth1-credential/callback`, async (req: express.Request, res: express.Response) => {
			const { oauth_verifier, oauth_token, cid } = req.query;

			if (oauth_verifier === undefined || oauth_token === undefined) {
				const errorResponse = new ResponseHelper.ResponseError('Insufficient parameters for OAuth1 callback. Received following query parameters: ' + JSON.stringify(req.query), undefined, 503);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			const result = await Db.collections.Credentials!.findOne(cid as any); // tslint:disable-line:no-any
			if (result === undefined) {
				const errorResponse = new ResponseHelper.ResponseError('The credential is not known.', undefined, 404);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			let encryptionKey = undefined;
			encryptionKey = await UserSettings.getEncryptionKey();
			if (encryptionKey === undefined) {
				const errorResponse = new ResponseHelper.ResponseError('No encryption key got found to decrypt the credentials!', undefined, 503);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			// Decrypt the currently saved credentials
			const workflowCredentials: IWorkflowCredentials = {
				[result.type as string]: {
					[result.name as string]: result as ICredentialsEncrypted,
				},
			};
			const credentialsHelper = new CredentialsHelper(workflowCredentials, encryptionKey);
			const decryptedDataOriginal = credentialsHelper.getDecrypted(result.name, result.type, true);
			const oauthCredentials = credentialsHelper.applyDefaultsAndOverwrites(decryptedDataOriginal, result.type);

			const options: OptionsWithUrl = {
				method: 'POST',
				url: _.get(oauthCredentials, 'accessTokenUrl') as string,
				qs: {
					oauth_token,
					oauth_verifier,
				}
			};

			let oauthToken;

			try {
				oauthToken = await requestPromise(options);
			} catch (error) {
				const errorResponse = new ResponseHelper.ResponseError('Unable to get access tokens!', undefined, 404);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			// Response comes as x-www-form-urlencoded string so convert it to JSON

			const oauthTokenJson = querystring.parse(oauthToken);

			decryptedDataOriginal.oauthTokenData = oauthTokenJson;

			const credentials = new Credentials(result.name, result.type, result.nodesAccess);
			credentials.setData(decryptedDataOriginal, encryptionKey);
			const newCredentialsData = credentials.getDataToSave() as unknown as ICredentialsDb;
			// Add special database related data
			newCredentialsData.updatedAt = this.getCurrentDate();
			// Save the credentials in DB
			await Db.collections.Credentials!.update(cid as any, newCredentialsData); // tslint:disable-line:no-any

			res.sendFile(pathResolve(__dirname, '../../templates/oauth-callback.html'));
		});


		// ----------------------------------------
		// OAuth2-Credential/Auth
		// ----------------------------------------


		// Authorize OAuth Data
		this.app.get(`/${this.restEndpoint}/oauth2-credential/auth`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<string> => {
			if (req.query.id === undefined) {
				res.status(500).send('Required credential id is missing.');
				return '';
			}

			const result = await Db.collections.Credentials!.findOne(req.query.id as string);
			if (result === undefined) {
				res.status(404).send('The credential is not known.');
				return '';
			}

			let encryptionKey = undefined;
			encryptionKey = await UserSettings.getEncryptionKey();
			if (encryptionKey === undefined) {
				res.status(500).send('No encryption key got found to decrypt the credentials!');
				return '';
			}

			// Decrypt the currently saved credentials
			const workflowCredentials: IWorkflowCredentials = {
				[result.type as string]: {
					[result.name as string]: result as ICredentialsEncrypted,
				},
			};
			const credentialsHelper = new CredentialsHelper(workflowCredentials, encryptionKey);
			const decryptedDataOriginal = credentialsHelper.getDecrypted(result.name, result.type, true);
			const oauthCredentials = credentialsHelper.applyDefaultsAndOverwrites(decryptedDataOriginal, result.type);

			const token = new csrf();
			// Generate a CSRF prevention token and send it as a OAuth2 state stringma/ERR
			const csrfSecret = token.secretSync();
			const state = {
				token: token.create(csrfSecret),
				cid: req.query.id,
			};
			const stateEncodedStr = Buffer.from(JSON.stringify(state)).toString('base64') as string;

			const oAuthOptions: clientOAuth2.Options = {
				clientId: _.get(oauthCredentials, 'clientId') as string,
				clientSecret: _.get(oauthCredentials, 'clientSecret', '') as string,
				accessTokenUri: _.get(oauthCredentials, 'accessTokenUrl', '') as string,
				authorizationUri: _.get(oauthCredentials, 'authUrl', '') as string,
				redirectUri: `${WebhookHelpers.getWebhookBaseUrl()}${this.restEndpoint}/oauth2-credential/callback`,
				scopes: _.split(_.get(oauthCredentials, 'scope', 'openid,') as string, ','),
				state: stateEncodedStr,
			};

			await this.externalHooks.run('oauth2.authenticate', [oAuthOptions]);

			const oAuthObj = new clientOAuth2(oAuthOptions);

			// Encrypt the data
			const credentials = new Credentials(result.name, result.type, result.nodesAccess);
			decryptedDataOriginal.csrfSecret = csrfSecret;

			credentials.setData(decryptedDataOriginal, encryptionKey);
			const newCredentialsData = credentials.getDataToSave() as unknown as ICredentialsDb;

			// Add special database related data
			newCredentialsData.updatedAt = this.getCurrentDate();

			// Update the credentials in DB
			await Db.collections.Credentials!.update(req.query.id as string, newCredentialsData);

			const authQueryParameters = _.get(oauthCredentials, 'authQueryParameters', '') as string;
			let returnUri = oAuthObj.code.getUri();

			// if scope uses comma, change it as the library always return then with spaces
			if ((_.get(oauthCredentials, 'scope') as string).includes(',')) {
				const data = querystring.parse(returnUri.split('?')[1] as string);
				data.scope = _.get(oauthCredentials, 'scope') as string;
				returnUri = `${_.get(oauthCredentials, 'authUrl', '')}?${querystring.stringify(data)}`;
			}

			if (authQueryParameters) {
				returnUri += '&' + authQueryParameters;
			}

			return returnUri;
		}));

		// ----------------------------------------
		// OAuth2-Credential/Callback
		// ----------------------------------------

		// Verify and store app code. Generate access tokens and store for respective credential.
		this.app.get(`/${this.restEndpoint}/oauth2-credential/callback`, async (req: express.Request, res: express.Response) => {
			const { code, state: stateEncoded } = req.query;

			if (code === undefined || stateEncoded === undefined) {
				const errorResponse = new ResponseHelper.ResponseError('Insufficient parameters for OAuth2 callback. Received following query parameters: ' + JSON.stringify(req.query), undefined, 503);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			let state;
			try {
				state = JSON.parse(Buffer.from(stateEncoded as string, 'base64').toString());
			} catch (error) {
				const errorResponse = new ResponseHelper.ResponseError('Invalid state format returned', undefined, 503);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			const result = await Db.collections.Credentials!.findOne(state.cid);
			if (result === undefined) {
				const errorResponse = new ResponseHelper.ResponseError('The credential is not known.', undefined, 404);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			let encryptionKey = undefined;
			encryptionKey = await UserSettings.getEncryptionKey();
			if (encryptionKey === undefined) {
				const errorResponse = new ResponseHelper.ResponseError('No encryption key got found to decrypt the credentials!', undefined, 503);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			// Decrypt the currently saved credentials
			const workflowCredentials: IWorkflowCredentials = {
				[result.type as string]: {
					[result.name as string]: result as ICredentialsEncrypted,
				},
			};
			const credentialsHelper = new CredentialsHelper(workflowCredentials, encryptionKey);
			const decryptedDataOriginal = credentialsHelper.getDecrypted(result.name, result.type, true);
			const oauthCredentials = credentialsHelper.applyDefaultsAndOverwrites(decryptedDataOriginal, result.type);

			const token = new csrf();
			if (decryptedDataOriginal.csrfSecret === undefined || !token.verify(decryptedDataOriginal.csrfSecret as string, state.token)) {
				const errorResponse = new ResponseHelper.ResponseError('The OAuth2 callback state is invalid!', undefined, 404);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			let options = {};

			const oAuth2Parameters = {
				clientId: _.get(oauthCredentials, 'clientId') as string,
				clientSecret: _.get(oauthCredentials, 'clientSecret', '') as string | undefined,
				accessTokenUri: _.get(oauthCredentials, 'accessTokenUrl', '') as string,
				authorizationUri: _.get(oauthCredentials, 'authUrl', '') as string,
				redirectUri: `${WebhookHelpers.getWebhookBaseUrl()}${this.restEndpoint}/oauth2-credential/callback`,
				scopes: _.split(_.get(oauthCredentials, 'scope', 'openid,') as string, ',')
			};

			if (_.get(oauthCredentials, 'authentication', 'header') as string === 'body') {
				options = {
					body: {
						client_id: _.get(oauthCredentials, 'clientId') as string,
						client_secret: _.get(oauthCredentials, 'clientSecret', '') as string,
					},
				};
				delete oAuth2Parameters.clientSecret;
			}

			await this.externalHooks.run('oauth2.callback', [oAuth2Parameters]);

			const oAuthObj = new clientOAuth2(oAuth2Parameters);

			const queryParameters = req.originalUrl.split('?').splice(1, 1).join('');

			const oauthToken = await oAuthObj.code.getToken(`${oAuth2Parameters.redirectUri}?${queryParameters}`, options);

			if (oauthToken === undefined) {
				const errorResponse = new ResponseHelper.ResponseError('Unable to get access tokens!', undefined, 404);
				return ResponseHelper.sendErrorResponse(res, errorResponse);
			}

			if (decryptedDataOriginal.oauthTokenData) {
				// Only overwrite supplied data as some providers do for example just return the
				// refresh_token on the very first request and not on subsequent ones.
				Object.assign(decryptedDataOriginal.oauthTokenData, oauthToken.data);
			} else {
				// No data exists so simply set
				decryptedDataOriginal.oauthTokenData = oauthToken.data;
			}

			_.unset(decryptedDataOriginal, 'csrfSecret');

			const credentials = new Credentials(result.name, result.type, result.nodesAccess);
			credentials.setData(decryptedDataOriginal, encryptionKey);
			const newCredentialsData = credentials.getDataToSave() as unknown as ICredentialsDb;
			// Add special database related data
			newCredentialsData.updatedAt = this.getCurrentDate();
			// Save the credentials in DB
			await Db.collections.Credentials!.update(state.cid, newCredentialsData);

			res.sendFile(pathResolve(__dirname, '../../templates/oauth-callback.html'));
		});


		// ----------------------------------------
		// Executions
		// ----------------------------------------


		// Returns all finished executions
		this.app.get(`/${this.restEndpoint}/executions`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IExecutionsListResponse> => {
			let filter: any = {}; // tslint:disable-line:no-any

			if (req.query.filter) {
				filter = JSON.parse(req.query.filter as string);
			}

			let limit = 20;
			if (req.query.limit) {
				limit = parseInt(req.query.limit as string, 10);
			}

			const countFilter = JSON.parse(JSON.stringify(filter));
			if (req.query.lastId) {
				filter.id = LessThan(req.query.lastId);
			}
			countFilter.select = ['id'];

			const resultsPromise = Db.collections.Execution!.find({
				select: [
					'id',
					'finished',
					'mode',
					'retryOf',
					'retrySuccessId',
					'startedAt',
					'stoppedAt',
					'workflowData',
				],
				where: filter,
				order: {
					id: 'DESC',
				},
				take: limit,
			});

			const countPromise = Db.collections.Execution!.count(countFilter);

			const results: IExecutionFlattedDb[] = await resultsPromise;
			const count = await countPromise;

			const returnResults: IExecutionsSummary[] = [];

			for (const result of results) {
				returnResults.push({
					id: result.id!.toString(),
					finished: result.finished,
					mode: result.mode,
					retryOf: result.retryOf ? result.retryOf.toString() : undefined,
					retrySuccessId: result.retrySuccessId ? result.retrySuccessId.toString() : undefined,
					startedAt: result.startedAt,
					stoppedAt: result.stoppedAt,
					workflowId: result.workflowData!.id ? result.workflowData!.id!.toString() : '',
					workflowName: result.workflowData!.name,
				});
			}

			return {
				count,
				results: returnResults,
			};
		}));


		// Returns a specific execution
		this.app.get(`/${this.restEndpoint}/executions/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IExecutionFlattedResponse | undefined> => {
			const result = await Db.collections.Execution!.findOne(req.params.id);

			if (result === undefined) {
				return undefined;
			}

			// Convert to response format in which the id is a string
			(result as IExecutionFlatted as IExecutionFlattedResponse).id = result.id.toString();
			return result as IExecutionFlatted as IExecutionFlattedResponse;
		}));


		// Retries a failed execution
		this.app.post(`/${this.restEndpoint}/executions/:id/retry`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<boolean> => {
			// Get the data to execute
			const fullExecutionDataFlatted = await Db.collections.Execution!.findOne(req.params.id);

			if (fullExecutionDataFlatted === undefined) {
				throw new ResponseHelper.ResponseError(`The execution with the id "${req.params.id}" does not exist.`, 404, 404);
			}

			const fullExecutionData = ResponseHelper.unflattenExecutionData(fullExecutionDataFlatted);

			if (fullExecutionData.finished === true) {
				throw new Error('The execution did succeed and can so not be retried.');
			}

			const executionMode = 'retry';

			const credentials = await WorkflowCredentials(fullExecutionData.workflowData.nodes);

			fullExecutionData.workflowData.active = false;

			// Start the workflow
			const data: IWorkflowExecutionDataProcess = {
				credentials,
				executionMode,
				executionData: fullExecutionData.data,
				retryOf: req.params.id,
				workflowData: fullExecutionData.workflowData,
			};

			const lastNodeExecuted = data!.executionData!.resultData.lastNodeExecuted as string;

			// Remove the old error and the data of the last run of the node that it can be replaced
			delete data!.executionData!.resultData.error;
			data!.executionData!.resultData.runData[lastNodeExecuted].pop();

			if (req.body.loadWorkflow === true) {
				// Loads the currently saved workflow to execute instead of the
				// one saved at the time of the execution.
				const workflowId = fullExecutionData.workflowData.id;
				data.workflowData = await Db.collections.Workflow!.findOne(workflowId) as IWorkflowBase;

				if (data.workflowData === undefined) {
					throw new Error(`The workflow with the ID "${workflowId}" could not be found and so the data not be loaded for the retry.`);
				}

				// Replace all of the nodes in the execution stack with the ones of the new workflow
				for (const stack of data!.executionData!.executionData!.nodeExecutionStack) {
					// Find the data of the last executed node in the new workflow
					const node = data.workflowData.nodes.find(node => node.name === stack.node.name);
					if (node === undefined) {
						throw new Error(`Could not find the node "${stack.node.name}" in workflow. It probably got deleted or renamed. Without it the workflow can sadly not be retried.`);
					}

					// Replace the node data in the stack that it really uses the current data
					stack.node = node;
				}
			}

			const workflowRunner = new WorkflowRunner();
			const executionId = await workflowRunner.run(data);

			const executionData = await this.activeExecutionsInstance.getPostExecutePromise(executionId);

			if (executionData === undefined) {
				throw new Error('The retry did not start for an unknown reason.');
			}

			return !!executionData.finished;
		}));


		// Delete Executions
		// INFORMATION: We use POST instead of DELETE to not run into any issues
		// with the query data getting to long
		this.app.post(`/${this.restEndpoint}/executions/delete`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<void> => {
			const deleteData = req.body as IExecutionDeleteFilter;

			if (deleteData.deleteBefore !== undefined) {
				const filters = {
					startedAt: LessThanOrEqual(deleteData.deleteBefore),
				};
				if (deleteData.filters !== undefined) {
					Object.assign(filters, deleteData.filters);
				}

				await Db.collections.Execution!.delete(filters);
			} else if (deleteData.ids !== undefined) {
				// Deletes all executions with the given ids
				await Db.collections.Execution!.delete(deleteData.ids);
			} else {
				throw new Error('Required body-data "ids" or "deleteBefore" is missing!');
			}
		}));


		// ----------------------------------------
		// Executing Workflows
		// ----------------------------------------


		// Returns all the currently working executions
		this.app.get(`/${this.restEndpoint}/executions-current`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IExecutionsSummary[]> => {
			const executingWorkflows = this.activeExecutionsInstance.getActiveExecutions();

			const returnData: IExecutionsSummary[] = [];

			let filter: any = {}; // tslint:disable-line:no-any
			if (req.query.filter) {
				filter = JSON.parse(req.query.filter as string);
			}

			for (const data of executingWorkflows) {
				if (filter.workflowId !== undefined && filter.workflowId !== data.workflowId) {
					continue;
				}
				returnData.push(
					{
						idActive: data.id.toString(),
						workflowId: data.workflowId.toString(),
						mode: data.mode,
						retryOf: data.retryOf,
						startedAt: new Date(data.startedAt),
					}
				);
			}

			return returnData;
		}));

		// Forces the execution to stop
		this.app.post(`/${this.restEndpoint}/executions-current/:id/stop`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IExecutionsStopData> => {
			const executionId = req.params.id;

			// Stopt he execution and wait till it is done and we got the data
			const result = await this.activeExecutionsInstance.stopExecution(executionId);

			if (result === undefined) {
				throw new Error(`The execution id "${executionId}" could not be found.`);
			}

			const returnData: IExecutionsStopData = {
				mode: result.mode,
				startedAt: new Date(result.startedAt),
				stoppedAt: new Date(result.stoppedAt),
				finished: result.finished,
			};

			return returnData;
		}));


		// Removes a test webhook
		this.app.delete(`/${this.restEndpoint}/test-webhook/:id`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<boolean> => {
			const workflowId = req.params.id;
			return this.testWebhooks.cancelTestWebhook(workflowId);
		}));



		// ----------------------------------------
		// Options
		// ----------------------------------------

		// Returns all the available timezones
		this.app.get(`/${this.restEndpoint}/options/timezones`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<object> => {
			return timezones;
		}));




		// ----------------------------------------
		// Settings
		// ----------------------------------------


		// Returns the settings which are needed in the UI
		this.app.get(`/${this.restEndpoint}/settings`, ResponseHelper.send(async (req: express.Request, res: express.Response): Promise<IN8nUISettings> => {
			return {
				endpointWebhook: this.endpointWebhook,
				endpointWebhookTest: this.endpointWebhookTest,
				saveDataErrorExecution: this.saveDataErrorExecution,
				saveDataSuccessExecution: this.saveDataSuccessExecution,
				saveManualExecutions: this.saveManualExecutions,
				executionTimeout: this.executionTimeout,
				maxExecutionTimeout: this.maxExecutionTimeout,
				timezone: this.timezone,
				urlBaseWebhook: WebhookHelpers.getWebhookBaseUrl(),
				versionCli: this.versions!.cli,
			};
		}));



		// ----------------------------------------
		// Webhooks
		// ----------------------------------------

		// HEAD webhook requests
		this.app.head(`/${this.endpointWebhook}/*`, async (req: express.Request, res: express.Response) => {
			// Cut away the "/webhook/" to get the registred part of the url
			const requestUrl = (req as ICustomRequest).parsedUrl!.pathname!.slice(this.endpointWebhook.length + 2);

			let response;
			try {
				response = await this.activeWorkflowRunner.executeWebhook('HEAD', requestUrl, req, res);
			} catch (error) {
				ResponseHelper.sendErrorResponse(res, error);
				return;
			}

			if (response.noWebhookResponse === true) {
				// Nothing else to do as the response got already sent
				return;
			}

			ResponseHelper.sendSuccessResponse(res, response.data, true, response.responseCode);
		});

		// OPTIONS webhook requests
		this.app.options(`/${this.endpointWebhook}/*`, async (req: express.Request, res: express.Response) => {
			// Cut away the "/webhook/" to get the registred part of the url
			const requestUrl = (req as ICustomRequest).parsedUrl!.pathname!.slice(this.endpointWebhook.length + 2);

			let allowedMethods: string[];
			try {
				allowedMethods = await this.activeWorkflowRunner.getWebhookMethods(requestUrl);
				allowedMethods.push('OPTIONS');

				// Add custom "Allow" header to satisfy OPTIONS response.
				res.append('Allow', allowedMethods);
			} catch (error) {
				ResponseHelper.sendErrorResponse(res, error);
				return;
			}

			ResponseHelper.sendSuccessResponse(res, {}, true, 204);
		});

		// GET webhook requests
		this.app.get(`/${this.endpointWebhook}/*`, async (req: express.Request, res: express.Response) => {
			// Cut away the "/webhook/" to get the registred part of the url
			const requestUrl = (req as ICustomRequest).parsedUrl!.pathname!.slice(this.endpointWebhook.length + 2);

			let response;
			try {
				response = await this.activeWorkflowRunner.executeWebhook('GET', requestUrl, req, res);
			} catch (error) {
				ResponseHelper.sendErrorResponse(res, error);
				return;
			}

			if (response.noWebhookResponse === true) {
				// Nothing else to do as the response got already sent
				return;
			}

			ResponseHelper.sendSuccessResponse(res, response.data, true, response.responseCode);
		});

		// POST webhook requests
		this.app.post(`/${this.endpointWebhook}/*`, async (req: express.Request, res: express.Response) => {
			// Cut away the "/webhook/" to get the registred part of the url
			const requestUrl = (req as ICustomRequest).parsedUrl!.pathname!.slice(this.endpointWebhook.length + 2);

			let response;
			try {
				response = await this.activeWorkflowRunner.executeWebhook('POST', requestUrl, req, res);
			} catch (error) {
				ResponseHelper.sendErrorResponse(res, error);
				return;
			}

			if (response.noWebhookResponse === true) {
				// Nothing else to do as the response got already sent
				return;
			}

			ResponseHelper.sendSuccessResponse(res, response.data, true, response.responseCode);
		});

		// HEAD webhook requests (test for UI)
		this.app.head(`/${this.endpointWebhookTest}/*`, async (req: express.Request, res: express.Response) => {
			// Cut away the "/webhook-test/" to get the registred part of the url
			const requestUrl = (req as ICustomRequest).parsedUrl!.pathname!.slice(this.endpointWebhookTest.length + 2);

			let response;
			try {
				response = await this.testWebhooks.callTestWebhook('HEAD', requestUrl, req, res);
			} catch (error) {
				ResponseHelper.sendErrorResponse(res, error);
				return;
			}

			if (response.noWebhookResponse === true) {
				// Nothing else to do as the response got already sent
				return;
			}

			ResponseHelper.sendSuccessResponse(res, response.data, true, response.responseCode);
		});

		// HEAD webhook requests (test for UI)
		this.app.options(`/${this.endpointWebhookTest}/*`, async (req: express.Request, res: express.Response) => {
			// Cut away the "/webhook-test/" to get the registred part of the url
			const requestUrl = (req as ICustomRequest).parsedUrl!.pathname!.slice(this.endpointWebhookTest.length + 2);

			let allowedMethods: string[];
			try {
				allowedMethods = await this.testWebhooks.getWebhookMethods(requestUrl);
				allowedMethods.push('OPTIONS');

				// Add custom "Allow" header to satisfy OPTIONS response.
				res.append('Allow', allowedMethods);
			} catch (error) {
				ResponseHelper.sendErrorResponse(res, error);
				return;
			}

			ResponseHelper.sendSuccessResponse(res, {}, true, 204);
		});

		// GET webhook requests (test for UI)
		this.app.get(`/${this.endpointWebhookTest}/*`, async (req: express.Request, res: express.Response) => {
			// Cut away the "/webhook-test/" to get the registred part of the url
			const requestUrl = (req as ICustomRequest).parsedUrl!.pathname!.slice(this.endpointWebhookTest.length + 2);

			let response;
			try {
				response = await this.testWebhooks.callTestWebhook('GET', requestUrl, req, res);
			} catch (error) {
				ResponseHelper.sendErrorResponse(res, error);
				return;
			}

			if (response.noWebhookResponse === true) {
				// Nothing else to do as the response got already sent
				return;
			}

			ResponseHelper.sendSuccessResponse(res, response.data, true, response.responseCode);
		});

		// POST webhook requests (test for UI)
		this.app.post(`/${this.endpointWebhookTest}/*`, async (req: express.Request, res: express.Response) => {
			// Cut away the "/webhook-test/" to get the registred part of the url
			const requestUrl = (req as ICustomRequest).parsedUrl!.pathname!.slice(this.endpointWebhookTest.length + 2);

			let response;
			try {
				response = await this.testWebhooks.callTestWebhook('POST', requestUrl, req, res);
			} catch (error) {
				ResponseHelper.sendErrorResponse(res, error);
				return;
			}

			if (response.noWebhookResponse === true) {
				// Nothing else to do as the response got already sent
				return;
			}

			ResponseHelper.sendSuccessResponse(res, response.data, true, response.responseCode);
		});


		if (this.endpointPresetCredentials !== '') {

			// POST endpoint to set preset credentials
			this.app.post(`/${this.endpointPresetCredentials}`, async (req: express.Request, res: express.Response) => {

				if (this.presetCredentialsLoaded === false) {

					const body = req.body as ICredentialsOverwrite;

					if (req.headers['content-type'] !== 'application/json') {
						ResponseHelper.sendErrorResponse(res, new Error('Body must be a valid JSON, make sure the content-type is application/json'));
						return;
					}

					const loadNodesAndCredentials = LoadNodesAndCredentials();

					const credentialsOverwrites = CredentialsOverwrites();

					await credentialsOverwrites.init(body);

					const credentialTypes = CredentialTypes();

					await credentialTypes.init(loadNodesAndCredentials.credentialTypes);

					this.presetCredentialsLoaded = true;

					ResponseHelper.sendSuccessResponse(res, { success: true }, true, 200);

				} else {
					ResponseHelper.sendErrorResponse(res, new Error('Preset credentials can be set once'));
				}
			});
		}


		// Read the index file and replace the path placeholder
		const editorUiPath = require.resolve('n8n-editor-ui');
		const filePath = pathJoin(pathDirname(editorUiPath), 'dist', 'index.html');
		const n8nPath = config.get('path');

		let readIndexFile = readFileSync(filePath, 'utf8');
		readIndexFile = readIndexFile.replace(/\/%BASE_PATH%\//g, n8nPath);
		readIndexFile = readIndexFile.replace(/\/favicon.ico/g, `${n8nPath}favicon.ico`);

		// Serve the altered index.html file separately
		this.app.get(`/index.html`, async (req: express.Request, res: express.Response) => {
			res.send(readIndexFile);
		});

		// Serve the website
		const startTime = (new Date()).toUTCString();
		this.app.use('/', express.static(pathJoin(pathDirname(editorUiPath), 'dist'), {
			index: 'index.html',
			setHeaders: (res, path) => {
				if (res.req && res.req.url === '/index.html') {
					// Set last modified date manually to n8n start time so
					// that it hopefully refreshes the page when a new version
					// got used
					res.setHeader('Last-Modified', startTime);
				}
			}
		}));
	}

}

export async function start(): Promise<void> {
	const PORT = config.get('port');
	const ADDRESS = config.get('listen_address');

	const app = new App();

	await app.config();

	let server;

	if (app.protocol === 'https' && app.sslKey && app.sslCert) {
		const https = require('https');
		const privateKey = readFileSync(app.sslKey, 'utf8');
		const cert = readFileSync(app.sslCert, 'utf8');
		const credentials = { key: privateKey, cert };
		server = https.createServer(credentials, app.app);
	} else {
		const http = require('http');
		server = http.createServer(app.app);
	}

	server.listen(PORT, ADDRESS, async () => {
		const versions = await GenericHelpers.getVersions();
		console.log(`n8n ready on ${ADDRESS}, port ${PORT}`);
		console.log(`Version: ${versions.cli}`);

		await app.externalHooks.run('n8n.ready', []);
	});
}
