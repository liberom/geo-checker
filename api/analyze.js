module.exports = async function (req, res) {
  const { key } = req.query;

  if (key !== process.env.MY_SECRET_ACCESS_STRING) {
    return res.status(401).json({ error: 'Unauthorized: Invalid access key' });
  }

  // Future: Call OpenRouter API here
  return res.status(200).json({ message: 'Success' });
};
