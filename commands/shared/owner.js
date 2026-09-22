import { SlashCommandBuilder } from 'discord.js';
import ownerCommand from '../shared/owner.js';
import { executeSharedCommand } from '../../utils/commandBridge.js';

export default {
    data: new SlashCommandBuilder()
        .setName('owner-tools')
        .setDescription('Owner-only administration tools.')
        .addSubcommand(subcommand => subcommand
            .setName('help')
            .setDescription('Show owner tools.'))
        .addSubcommand(subcommand => subcommand
            .setName('stats')
            .setDescription('Show database counts.'))
        .addSubcommand(subcommand => subcommand
            .setName('dbcheck')
            .setDescription('Check MongoDB connectivity.'))
        .addSubcommand(subcommand => subcommand
            .setName('cleantest')
            .setDescription('Remove test user records.'))
        .addSubcommand(subcommand => subcommand
            .setName('user')
            .setDescription('Inspect a player.')
            .addStringOption(option => option.setName('user_id').setDescription('Discord user ID.').setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName('grant')
            .setDescription('Grant cash to a player.')
            .addStringOption(option => option.setName('user_id').setDescription('Discord user ID.').setRequired(true))
            .addNumberOption(option => option.setName('amount').setDescription('Cash amount.').setRequired(true).setMinValue(1)))
        .addSubcommand(subcommand => subcommand
            .setName('premium')
            .setDescription('Change player premium status.')
            .addStringOption(option => option.setName('user_id').setDescription('Discord user ID.').setRequired(true))
            .addBooleanOption(option => option.setName('enabled').setDescription('Whether premium is enabled.').setRequired(true))),
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const userId = interaction.options.getString('user_id');
        const amount = interaction.options.getNumber('amount');
        const enabled = interaction.options.getBoolean('enabled');
        const args = [subcommand];
        if (userId) args.push(userId);
        if (amount !== null) args.push(String(amount));
        if (enabled !== null) args.push(enabled ? 'on' : 'off');
        return executeSharedCommand(interaction, ownerCommand, args);
    }
};
