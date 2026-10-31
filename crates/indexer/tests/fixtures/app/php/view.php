<?php
$id = $_GET['id'];
$result = mysqli_query($conn, "SELECT * FROM posts WHERE id = '$id'");
echo "<h1>" . $_GET['title'] . "</h1>";
