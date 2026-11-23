// The Apple team that signs the build comes from the environment, so it is not in the repository.
module.exports = ({ config }) => ({ ...config, ios: { ...config.ios, appleTeamId: process.env.APPLE_TEAM_ID } });
