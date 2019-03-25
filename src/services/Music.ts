import { Guild, Message, VoiceChannel, VoiceConnection } from 'eris';

import { MusicCache } from '../cache/MusicCache';
import { IMClient } from '../client';
import { MusicQueue, MusicQueueItem } from '../types';

const VOL_FADE_TIME = 1.5;

class MusicConnection {
	private service: MusicService;
	private musicQueueCache: MusicQueue;
	private voiceChannel: VoiceChannel;
	private connection: VoiceConnection;
	private nowPlayingMessage: Message;
	private volume: number = 1.0;
	private doPlayNext: boolean = true;
	private speaking: Set<string> = new Set();

	public constructor(service: MusicService, musicQueueCache: MusicQueue) {
		this.service = service;
		this.musicQueueCache = musicQueueCache;
	}

	public switchChannel(voiceChannel: VoiceChannel) {
		this.voiceChannel = voiceChannel;
		this.connection.switchChannel(voiceChannel.id);
	}

	public isPlaying(): boolean {
		return this.connection && this.connection.playing;
	}

	public isPaused(): boolean {
		return this.connection && this.connection.paused;
	}

	public isConnected(): boolean {
		return !!this.connection;
	}

	public async play(item: MusicQueueItem, voiceChannel?: VoiceChannel) {
		console.log(item);

		if (voiceChannel) {
			await this.connect(voiceChannel);
		} else if (!this.connection) {
			if (this.voiceChannel) {
				await this.connect(this.voiceChannel);
			} else {
				throw new Error('Not connected and no voice channel specified');
			}
		}

		this.musicQueueCache.queue.push(item);
		if (!this.musicQueueCache.current) {
			this.playNext();
		}

		this.updateNowPlayingMessage();
	}

	public pause() {
		if (this.connection) {
			this.connection.pause();
		}
	}

	public resume() {
		if (this.connection) {
			this.connection.resume();
		}
	}

	public async rewind() {
		if (!this.connection) {
			if (this.voiceChannel) {
				await this.connect(this.voiceChannel);
			} else {
				throw new Error('Not connected to a voice channel');
			}
		}

		this.musicQueueCache.queue.unshift(this.musicQueueCache.current);
		this.playNext();
	}

	public async skip() {
		if (this.connection) {
			this.playNext();
		}
	}

	public setVolume(volume: number) {
		if (this.connection) {
			this.volume = volume;
			this.fadeVolumeTo(volume);
		}
	}

	public getNowPlaying() {
		return this.musicQueueCache.current;
	}

	public getQueue() {
		return this.musicQueueCache.queue;
	}

	public setNowPlayingMessage(message: Message) {
		this.nowPlayingMessage = message;
	}

	private speakTimeout: NodeJS.Timer;
	public async connect(channel: VoiceChannel) {
		if (this.connection) {
			this.switchChannel(channel);
		} else {
			this.voiceChannel = channel;
			this.connection = await channel.join({ inlineVolume: true });
			this.connection.on('speakingStart', userId => {
				if (this.speaking.size === 0) {
					if (this.speakTimeout) {
						clearTimeout(this.speakTimeout);
						this.speakTimeout = null;
					} else {
						this.cancelFadeVolume();
						this.connection.setVolume(0.2 * this.volume);
						// this.fadeVolumeTo(0.2 * this.volume);
					}
				}
				this.speaking.add(userId);
			});
			this.connection.on('speakingStop', userId => {
				this.speaking.delete(userId);
				if (this.speaking.size === 0) {
					const func = () => {
						this.speakTimeout = null;
						this.fadeVolumeTo(this.volume);
					};
					this.speakTimeout = setTimeout(func, 1000);
				}
			});
			this.connection.on('end', () => {
				console.log('STREAM END');
				this.musicQueueCache.current = null;
				if (this.doPlayNext) {
					this.playNext();
				}
			});
		}
	}

	private playNext() {
		const next = this.musicQueueCache.queue.shift();
		if (next) {
			if (this.connection.playing) {
				this.doPlayNext = false;
				this.connection.stopPlaying();
			}

			this.musicQueueCache.current = next;
			this.connection.play(next.stream, {
				inlineVolume: true
			});
			this.updateNowPlayingMessage();

			this.doPlayNext = true;
		}
	}

	public seek(time: number) {
		this.doPlayNext = false;

		const current = this.musicQueueCache.current;
		this.connection.stopPlaying();
		this.connection.play(current.stream, {
			inlineVolume: true,
			inputArgs: [`-ss`, `${time}`]
		});
		this.musicQueueCache.current = current;
		this.doPlayNext = true;
	}

	private fadeTimeouts: NodeJS.Timer[] = [];
	private fadeVolumeTo(newVolume: number) {
		this.cancelFadeVolume();

		const startVol = this.connection.volume;
		const diff = newVolume - startVol;
		const step = diff / (VOL_FADE_TIME * 10);
		for (let i = 0; i < VOL_FADE_TIME * 10; i++) {
			const newVol = Math.max(0, Math.min(startVol + i * step, 2));
			this.fadeTimeouts.push(
				setTimeout(() => this.connection.setVolume(newVol), i * 100)
			);
		}
	}

	private cancelFadeVolume() {
		this.fadeTimeouts.forEach(t => clearTimeout(t));
		this.fadeTimeouts = [];
	}

	private updateNowPlayingMessage() {
		if (this.nowPlayingMessage) {
			this.nowPlayingMessage.edit({
				embed: this.service.createPlayingEmbed(null)
			});
		}
	}

	public disconnect() {
		if (this.connection) {
			this.connection.stopPlaying();
			this.voiceChannel.leave();
			this.connection = null;
		}
	}
}

export class MusicService {
	private client: IMClient = null;
	private cache: MusicCache;
	private musicConnections: Map<string, MusicConnection>;

	public constructor(client: IMClient) {
		this.client = client;
		this.cache = client.cache.music;
		this.musicConnections = new Map();
	}

	public async getMusicConnection(guild: Guild) {
		let conn = this.musicConnections.get(guild.id);
		if (!conn) {
			conn = new MusicConnection(this, await this.cache.get(guild.id));
			this.musicConnections.set(guild.id, conn);
		}
		return conn;
	}

	public createPlayingEmbed(item: MusicQueueItem) {
		if (!item) {
			return this.client.msg.createEmbed({
				author: { name: 'InvMan Music', icon_url: this.client.user.avatarURL },
				color: 255, // blue
				title: 'Not playing',
				fields: []
			});
		}

		return this.client.msg.createEmbed({
			author: {
				name: `${item.user.username}#${item.user.discriminator}`,
				icon_url: item.user.avatarURL
			},
			image: { url: item.imageURL },
			color: 255, // blue
			title: item.title,
			fields: item.extras
		});
	}
}