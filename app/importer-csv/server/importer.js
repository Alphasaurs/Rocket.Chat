import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

import {
	RawImports,
	Base,
	ProgressStep,
	Selection,
	SelectionChannel,
	SelectionUser,
	ImporterWebsocket,
} from '../../importer/server';
import { Rooms } from '../../models';
import { t } from '../../utils';

export class CsvImporter extends Base {
	constructor(info, importRecord) {
		super(info, importRecord);

		this.csvParser = require('csv-parse/lib/sync');
	}

	prepareUsingLocalFile(fullFilePath) {
		this.logger.debug('start preparing import operation');
		this.collection.remove({});

		const zip = new this.AdmZip(fullFilePath);
		const totalEntries = zip.getEntryCount();

		ImporterWebsocket.progressUpdated({ rate: 0 });

		let tempChannels = [];
		let tempUsers = [];
		let hasDirectMessages = false;
		let count = 0;
		let oldRate = 0;

		const increaseCount = () => {
			try {
				count++;
				const rate = Math.floor(count * 1000 / totalEntries) / 10;
				if (rate > oldRate) {
					ImporterWebsocket.progressUpdated({ rate });
					oldRate = rate;
				}
			} catch (e) {
				console.error(e);
			}
		};

		let messagesCount = 0;
		zip.forEach((entry) => {
			this.logger.debug(`Entry: ${ entry.entryName }`);

			// Ignore anything that has `__MACOSX` in it's name, as sadly these things seem to mess everything up
			if (entry.entryName.indexOf('__MACOSX') > -1) {
				this.logger.debug(`Ignoring the file: ${ entry.entryName }`);
				return increaseCount();
			}

			// Directories are ignored, since they are "virtual" in a zip file
			if (entry.isDirectory) {
				this.logger.debug(`Ignoring the directory entry: ${ entry.entryName }`);
				return increaseCount();
			}

			// Parse the channels
			if (entry.entryName.toLowerCase() === 'channels.csv') {
				super.updateProgress(ProgressStep.PREPARING_CHANNELS);
				const parsedChannels = this.csvParser(entry.getData().toString());
				tempChannels = parsedChannels.map((c) => ({
					id: Random.id(),
					name: c[0].trim(),
					creator: c[1].trim(),
					isPrivate: c[2].trim().toLowerCase() === 'private',
					members: c[3].trim().split(';').map((m) => m.trim()).filter((m) => m),
				}));
				return increaseCount();
			}

			// Parse the users
			if (entry.entryName.toLowerCase() === 'users.csv') {
				super.updateProgress(ProgressStep.PREPARING_USERS);
				const parsedUsers = this.csvParser(entry.getData().toString());
				tempUsers = parsedUsers.map((u) => ({ id: Random.id(), username: u[0].trim(), email: u[1].trim(), name: u[2].trim() }));

				super.updateRecord({ 'count.users': tempUsers.length });

				return increaseCount();
			}

			// Parse the messages
			if (entry.entryName.indexOf('/') > -1) {
				if (this.progress.step !== ProgressStep.PREPARING_MESSAGES) {
					super.updateProgress(ProgressStep.PREPARING_MESSAGES);
				}

				const item = entry.entryName.split('/'); // random/messages.csv
				const folderName = item[0]; // random

				let msgs = [];

				try {
					msgs = this.csvParser(entry.getData().toString());
				} catch (e) {
					this.logger.warn(`The file ${ entry.entryName } contains invalid syntax`, e);
					return increaseCount();
				}

				let data;
				const msgGroupData = item[1].split('.')[0]; // messages

				if (folderName.toLowerCase() === 'directmessages') {
					hasDirectMessages = true;
					data = msgs.map((m) => ({ username: m[0], ts: m[2], text: m[3], otherUsername: m[1], isDirect: true }));
				} else {
					data = msgs.map((m) => ({ username: m[0], ts: m[1], text: m[2] }));
				}

				messagesCount += data.length;
				const channelName = `${ folderName }/${ msgGroupData }`;

				super.updateRecord({ messagesstatus: channelName });

				if (Base.getBSONSize(data) > Base.getMaxBSONSize()) {
					Base.getBSONSafeArraysFromAnArray(data).forEach((splitMsg, i) => {
						this.collection.insert({ import: this.importRecord._id, importer: this.name, type: 'messages', name: `${ channelName }.${ i }`, messages: splitMsg, channel: folderName, i, msgGroupData });
					});
				} else {
					this.collection.insert({ import: this.importRecord._id, importer: this.name, type: 'messages', name: channelName, messages: data, channel: folderName, msgGroupData });
				}

				super.updateRecord({ 'count.messages': messagesCount, messagesstatus: null });
				return increaseCount();
			}

			increaseCount();
		});

		this.collection.insert({ import: this.importRecord._id, importer: this.name, type: 'users', users: tempUsers });
		super.addCountToTotal(messagesCount + tempUsers.length);
		ImporterWebsocket.progressUpdated({ rate: 100 });

		if (hasDirectMessages) {
			tempChannels.push({
				id: '#directmessages#',
				name: t('Direct_Messages'),
				creator: 'rocket.cat',
				isPrivate: false,
				isDirect: true,
				members: [],
			});
		}

		// Insert the channels records.
		this.collection.insert({ import: this.importRecord._id, importer: this.name, type: 'channels', channels: tempChannels });
		super.updateRecord({ 'count.channels': tempChannels.length });
		super.addCountToTotal(tempChannels.length);

		// Ensure we have at least a single user, channel, or message
		if (tempUsers.length === 0 && tempChannels.length === 0 && messagesCount === 0) {
			this.logger.error('No users, channels, or messages found in the import file.');
			super.updateProgress(ProgressStep.ERROR);
			return super.getProgress();
		}

		const selectionUsers = tempUsers.map((u) => new SelectionUser(u.id, u.username, u.email, false, false, true));
		const selectionChannels = tempChannels.map((c) => new SelectionChannel(c.id, c.name, false, true, c.isPrivate, undefined, c.isDirect));
		const selectionMessages = this.importRecord.count.messages;

		super.updateProgress(ProgressStep.USER_SELECTION);
		return new Selection(this.name, selectionUsers, selectionChannels, selectionMessages);
	}

	startImport(importSelection) {
		this.converter.clearImportData();

		this.users = RawImports.findOne({ import: this.importRecord._id, type: 'users' });
		this.channels = RawImports.findOne({ import: this.importRecord._id, type: 'channels' });
		this.reloadCount();

		const rawCollection = this.collection.model.rawCollection();
		const distinct = Meteor.wrapAsync(rawCollection.distinct, rawCollection);

		super.startImport(importSelection);
		const started = Date.now();

		// Ensure we're only going to import the users that the user has selected
		for (const user of importSelection.users) {
			for (const u of this.users.users) {
				if (u.id === user.user_id) {
					u.do_import = user.do_import;
				}
			}
		}
		this.collection.update({ _id: this.users._id }, { $set: { users: this.users.users } });

		// Ensure we're only importing the channels the user has selected.
		for (const channel of importSelection.channels) {
			for (const c of this.channels.channels) {
				if (c.id === channel.channel_id) {
					c.do_import = channel.do_import;
				}
			}
		}
		this.collection.update({ _id: this.channels._id }, { $set: { channels: this.channels.channels } });

		const startedByUserId = Meteor.userId();
		Meteor.defer(() => {
			super.updateProgress(ProgressStep.IMPORTING_USERS);

			try {
				// Import the users
				for (const u of this.users.users) {
					if (!u.do_import) {
						continue;
					}

					this.converter.addUser({
						importIds: [
							u.username,
						],
						emails: [
							u.email,
						],
						username: u.username,
						name: u.name,
					});

					super.addCountCompleted(1);
				}
				this.collection.update({ _id: this.users._id }, { $set: { users: this.users.users } });

				// Import the channels
				super.updateProgress(ProgressStep.IMPORTING_CHANNELS);
				for (const c of this.channels.channels) {
					if (!c.do_import) {
						continue;
					}

					if (c.isDirect) {
						super.addCountCompleted(1);
						continue;
					}

					this.converter.addChannel({
						importIds: [
							c.id,
						],
						u: {
							_id: c.creator,
						},
						name: c.name,
						users: c.members,
						t: c.isPrivate ? 'p' : 'c',
					});

					super.addCountCompleted(1);
				}
				this.collection.update({ _id: this.channels._id }, { $set: { channels: this.channels.channels } });

				// If no channels file, collect channel map from DB for message-only import
				if (this.channels.channels.length === 0) {
					const channelNames = distinct('channel', { import: this.importRecord._id, type: 'messages', channel: { $ne: 'directMessages' } });
					for (const cname of channelNames) {
						Meteor.runAsUser(startedByUserId, () => {
							const existantRoom = Rooms.findOneByName(cname);
							if (existantRoom || cname.toUpperCase() === 'GENERAL') {
								this.channels.channels.push({
									id: cname.replace('.', '_'),
									name: cname,
									do_import: true,
								});
							}
						});
					}
				}

				// Import the Messages
				super.updateProgress(ProgressStep.IMPORTING_MESSAGES);

				const messagePacks = this.collection.find({ import: this.importRecord._id, type: 'messages' });
				messagePacks.forEach((pack) => {
					const ch = pack.channel;
					const { msgGroupData } = pack;

					const csvChannel = this.getChannelFromName(ch);
					if (!csvChannel || !csvChannel.do_import) {
						return;
					}

					if (csvChannel.isDirect) {
						this._importDirectMessagesFile(msgGroupData, pack, startedByUserId);
						return;
					}

					if (ch.toLowerCase() === 'directmessages') {
						return;
					}

					super.updateRecord({ messagesstatus: `${ ch }/${ msgGroupData }.${ pack.messages.length }` });
					for (const msg of pack.messages) {
						const newMessage = {
							rid: csvChannel.id,
							u: {
								_id: msg.username,
							},
							ts: new Date(parseInt(msg.ts)),
							msg: msg.text,
						};

						this.converter.addMessage(newMessage);
						super.addCountCompleted(1);
					}
				});

				this.converter.convertData(startedByUserId);

				super.updateProgress(ProgressStep.FINISHING);
				super.updateProgress(ProgressStep.DONE);
			} catch (e) {
				this.logger.error(e);
				super.updateProgress(ProgressStep.ERROR);
			}

			const timeTook = Date.now() - started;
			this.logger.log(`CSV Import took ${ timeTook } milliseconds.`);
		});

		return super.getProgress();
	}

	_importDirectMessagesFile(msgGroupData, msgs, startedByUserId) {
		const dmRooms = new Map();

		Meteor.runAsUser(startedByUserId, () => {
			super.updateRecord({ messagesstatus: `${ t('Direct_Messages') }/${ msgGroupData }.${ msgs.messages.length }` });
			for (const msg of msgs.messages) {
				const sourceId = [msg.username, msg.otherUsername].sort().join('/');

				if (!dmRooms.has(sourceId)) {
					this.converter.addChannel({
						importIds: [
							sourceId,
						],
						users: [msg.username, msg.otherUsername],
						t: 'd',
					});

					dmRooms.set(sourceId, true);
				}

				const newMessage = {
					rid: sourceId,
					u: {
						_id: msg.username,
					},
					ts: new Date(parseInt(msg.ts)),
					msg: msg.text,
				};

				this.converter.addMessage(newMessage);

				super.addCountCompleted(1);
			}
		});
	}

	getChannelFromName(channelName) {
		if (channelName.toLowerCase() === 'directmessages') {
			return this.getDirectMessagesChannel();
		}

		for (const ch of this.channels.channels) {
			if (ch.name === channelName) {
				return ch;
			}
		}
	}

	getDirectMessagesChannel() {
		for (const ch of this.channels.channels) {
			if (ch.is_direct || ch.isDirect) {
				return ch;
			}
		}
	}
}
