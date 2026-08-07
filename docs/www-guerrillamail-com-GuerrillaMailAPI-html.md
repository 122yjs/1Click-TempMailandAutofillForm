# Guerrilla Mail JSON API

version 1.0, 19th Apr 2011

The latest version of this document is available on Google Docs here: [https://docs.google.com/document/d/1Qw5KQP1j57BPTDmms5nspe-QAjNEsNg8cQHpAAycYNM/edit?hl=en](https://docs.google.com/document/d/1Qw5KQP1j57BPTDmms5nspe-QAjNEsNg8cQHpAAycYNM/edit?hl=en)

### Introduction

Guerrilla Mail provides a JSON API through HTTP. The API is public and open to all.

The API URL is located at: [http://api.guerrillamail.com/ajax.php](http://api.guerrillamail.com/ajax.php)

Each request to the above URL must have a parameter ‘f’, indicating the function name. It should also pass ‘ip’ and ‘agent’ to indicate the IP address and user-agent of the user-end. Followed by the argument(s) as required by the function specification. The result will be returned in a JSON encoded string.

Example:  http://api.guerrillamail.com/ajax.php?f=get\_email\_address&ip=127.0.0.1&agent=Mozilla\_foo\_bar

As a requirement, the client interacting with the API must be able to save, send and receive the following cookies

SUBSCR - A subscriber cookie. Set by the server if the email address has an active subscription. The client must save this value if changed, but does not need to send as a cookie at each request. (The value is later used as a parameter to a function call)

PHPSESSID - A session ID. Set by the server for each client to maintain state. The client must always look for this cookie in the HTTP header, remember it (if changed), and then provide it as cookie data in each HTTP request. This value can change at every call, and when it changes, it indicates that a new session was started; the client would need to re-fresh the interace with new data.

Note: The API may be rate limited, but we do not publish our rate limits. Please use this API carefully.

Created a guerrilla mail app? Let us know support@guerrillamail.com

### Flow

1\. User accesses the Guerrilla Mail Application, an email address is given. App initialization, the mail box is loaded. (Call to get\_email\_address is made, the client can get the session id, email address and email address’ timestamp)

2\. Check for new email, this could be a function that works in the background (A call to check\_email is made)

3\. New email arrives, the user clicks on it. Email is fetched and displayed (A call to fetch\_email is made)

4\. To change the email address - the user can set the email address.  (A call to set\_email\_user is made). After making a call to this function, the client can fetch the email list for this email by checking the email. Note: When a user changes the email address from one address to another, the old email address and its emails are NOT deleted, if the user changes back to the old address then their messages will still be there until the address expires or the message is 1 hour old.

5\. Forget email - tell the server forget the current email address (but do not delete it) (A call to forget\_me is made)

6\. Extend time - Tell the server extend time for the current address (A call to extend is made)

7\. Email expired - The client should keep time of when the email expires. Some calls also return a timestamp. The timestamp is a Unix timestamp, indicating when the address was created. The client can calculate how many minutes are remaining:

seconds remaining = 3600 - Current Timestamp - Email Timestamp

Note: A session can expire after about 18 minutes of inactivity. If a session expires, a new email address will be generated when making a call to get\_email\_address , a user can always return to the old email address by making a call to set\_email\_user

### Functions

Each HTTP request to [http://api.guerrillamail.com/ajax.php](http://api.guerrillamail.com/ajax.php) is considered a function call. The client could use GET when querying for data, and POST when setting or deleting data, although this is not strictly enforced. Each request must contain the ‘f’ parameter containing the function name, the ‘ip’ parameter of the end user, and the ‘agent’ parameter of the end user’s user agent.

##### Function

get\_email\_address

##### Arguments

1. ‘lang’ - a string representing the language code. Currently supported: en, fr, nl, ru, tr, uk, ar, ko, jp, zh, zh-hant

1. ‘SUBSCR’ - the subscriber cookie data, given to the client in a previous session

##### Description

The function is used to initialize a session and set the client with an email address. If the session already exists, then it will return the email address details of the existing session. If a new session needs to be created, then it will first check for the SUBSCR cookie to create a session for a subscribed address, otherwise it will create new email address randomly.

The session is maintained using HTTP Cookies. The cookie name is ‘PHPSESSID’, and it will be given in the resulting HTTP header. The client should always store this cookie and send it whenever making an API call. A new session will be created when the ‘PHPSESSID’ cookie is not given by the client. The function also generates a new welcome email for the user.

To send ‘PHPSESSID’ in a HTTP request, add the following line to the header:

Cookie: PHPSESSID=ABC1234\\r\\n";

Where ‘ABC1234’ is the data for the ‘PHPSESSID’ cookie.

The client should always watch the ‘PHPSESSID’ cookie for changes. If it changes, it needs to update this value, and pass it in subsequent calls.

##### Returns

An object with the following properties:

1. ‘email\_addr’ - The email address that that was determined. If a previous session was found, then it will be the email address of that session. If the SUBSCR cookie was matched, it will be the email in the cookie, otherwise a new random email address will be created.

1. ‘email\_timestamp’ - a UNIX timestamp when the email address was created. Used by the client to keep track of expiry.

1. ‘s\_active’ - Subscription active, Y or N
2. ‘s\_date’ - The full date of the subscription
3. ‘s\_time’ - The UNIX timestamp of subscription
4. ‘s\_time\_expires’ - The UNIX timestamp for when the subscription expires

Note that the server could set a new SUBSCR cookie, also it may return with a new PHPSESSID cookie which you would need to update and store in your client.

##### Function

set\_email\_user

##### Arguments

1. ‘email\_user’ - String. The username part of an email address. example: test@guerrillamailblock.com, the email\_user part would be ‘test’

1. ‘lang’ - String. The language code, eg. ‘en’

Note: PHPSESSID must be passed as a cookie

##### Description

Set the email address to a different email address. If the email address is a subscriber, then return the subscription details. If the email is not a subscriber, then the email address will be given 60 minutes again. A new email address will be generated if the email address is not in the database and a welcome email message will be generated.

##### Returns

Similar to get\_email\_address, this function returns an object with the following properties:

1. ‘email\_addr’ - The email address that that was determined. If a previous session was found, then it will be the email address of that session. If the SUBSCR cookie was matched, it will be the email in the cookie, otherwise a new random email address will be created. Eg, test@guerrillamailblock.com

1. ‘email\_timestamp’ - a UNIX timestamp when the email address was created. Used by the client to keep track of expiry.

1. ‘s\_active’ - Subscription active, Y or N
2. ‘s\_date’ - The full date of the subscription
3. ‘s\_time’ - The UNIX timestamp of subscription
4. ‘s\_time\_expires’ - The UNIX timestamp for when the subscription expires

##### Function

check\_email

##### Arguments

1. seq - The sequence number (id) of the oldest email

##### Description

Check for new email on the server. Returns a list of the newest messages. The maximum size of the list is 20 items.

The client should not check email too many times as to not overload the server. Do not check if the email expired, the email checking routing should pause if the email expired.

##### Returns

An an object with the following properties:

1. ‘list’ - A list of messages, represented as an array of objects. Each object has the following properties:

           ‘mail\_id’,

‘mail\_from’ (email address of sender),

‘mail\_subject’,

‘mail\_excerpt’ (snippet from the email),

‘mail\_timestamp’ (a UNIX timestamp),

‘mail\_read’ (1 if read, 0 if not), ‘mail\_date’

Note: ‘mail\_subject’ and ‘mail\_excerpt’ are escaped using HTML Entities.

1. ‘count’ - The number of emails matched. This can be much more than the maximum that can be returned (20)! This number indicates the total number of new emails in the database. (If you want to get the emails after the first 20, then make another call with the get\_older\_list function

1. ‘email’ - The email address which the list is for. Eg. [test@guerrillamailblock.com](mailto:test@guerrillamailblock.com) The client would need to watch this variable to detect any changes to sync the address.
2. ‘ts’ - The timestamp of the email address, time of when the email address was created. The client can use this variable to sync the time. Emails expire after 60 minutes
3. ‘s\_active’ - Subscription active, Y or N
4. ‘s\_date’ - The full date of the subscription
5. ‘s\_time’ - The UNIX timestamp of subscription
6. ‘s\_time\_expires’ - The UNIX timestamp for when the subscription expires

##### Function

get\_email\_list

##### Arguments

1. ‘offset’ - How many emails to start from (skip). Starts from 0

1. ‘seq’ - The sequence number(id) of the first email, optional

##### Description

Gets a maximum of 20 messages from the specified offset. Offset of 0 will fetch a list of the first 10 emails, offset of 10 will fetch a list of the next 10, and so on.

This function is useful for populating the initial email list. Note: When returned, subject and email excerpt are escaped using HTML Entities.

##### Returns

Identical to check\_email described above

##### Function

fetch\_email

##### Arguments

1. email\_id - The id of the email to fetch

##### Description

Get the contents of an email.

Notes:

\- All HTML in the body of the email is filtered. Eg, Javascript, applets, iframes, etc is removed.

\- All images in the email are relative to [http://www.guerrillamail.com/res.php](http://www.guerrillamail.com/res.php) \- this script will generate a ‘blocked by GM’ image, indicating that the image was blocked. The CGI parameters for this script are as follows:

r = Is it a resource? 1 if true. Always 1

n= Node. The element type. Can be a string of letters (a-z)

q= The query string for the original image. This is URL Encoded

        Example URL: [http://www.guerrillamail.com/res.php?](http://www.guerrillamail.com/res.php?r=1&n=img&q=http%3A%2F%2Fstatic.groupon.de%2Fnewsletter_ums%2Flogo_groupon_de_DE.gif)[r](http://www.guerrillamail.com/res.php?r=1&n=img&q=http%3A%2F%2Fstatic.groupon.de%2Fnewsletter_ums%2Flogo_groupon_de_DE.gif)[=1&](http://www.guerrillamail.com/res.php?r=1&n=img&q=http%3A%2F%2Fstatic.groupon.de%2Fnewsletter_ums%2Flogo_groupon_de_DE.gif)[n](http://www.guerrillamail.com/res.php?r=1&n=img&q=http%3A%2F%2Fstatic.groupon.de%2Fnewsletter_ums%2Flogo_groupon_de_DE.gif)[=img&](http://www.guerrillamail.com/res.php?r=1&n=img&q=http%3A%2F%2Fstatic.groupon.de%2Fnewsletter_ums%2Flogo_groupon_de_DE.gif)[q](http://www.guerrillamail.com/res.php?r=1&n=img&q=http%3A%2F%2Fstatic.groupon.de%2Fnewsletter_ums%2Flogo_groupon_de_DE.gif)[=http%3A%2F%2Fstatic.groupon.de%2Fnewsletter\_ums%2Flogo\_groupon\_de\_DE.gif](http://www.guerrillamail.com/res.php?r=1&n=img&q=http%3A%2F%2Fstatic.groupon.de%2Fnewsletter_ums%2Flogo_groupon_de_DE.gif)

        When an email is displayed by the client, it should displayed the blocked images generated by res.php. When a ‘Display Images’ button is clicked, the client should use a regular expression to replace the links to res.php with the links to the image found in the ‘q’ parameter. Here is an example of this regular expression in the Javascript client:

// Javascript example: This will replace all the res.php links inside double quotes with the URL stored in the q parameter. Since the URL in the q parameter is URL Escaped, we need to define an anonymous function to unescape the matched parameter. The ‘g’ flag tells the regex engine to replace all occurrences in the string.

temp\_html = temp\_html.replace(/"\\/res\\.php\\?r=1&amp;n=\[a-z\]+&amp;q=(\[^"^&\]+)"/g, function(str, p1, offset, s) {return unescape (p1); } );

       // Sometimes the link can be enclosed inside html encoded quotes, &quot;

temp\_html = temp\_html.replace(/&quot;\\/res\\.php\\?r=1&amp;n=\[a-z\]+&amp;q=(\[^"\]+)&quot;/g, function(str, p1, offset, s) {return "&quot;"+unescape(p1)+"&quot;" ; } );

Here is the above example written as PHP code (using the ‘e’ modifier allows us to call the urldecode function on the matched parameter):

$source = preg\_replace ('#"/res\\.php\\?r=1&amp;n=img&amp;q=(\[^"\]+)"#e', "urldecode('\\\1')", $source);

$source = preg\_replace ('#&quot;/res\\.php\\?r=1&amp;n=img&amp;q=(\[^"\]+)&quot;#e', "urldecode('\\\1')", $source);

\- Subject and email excerpt are escaped using HTML Entities.

\- Only emails owned by the current session id can be fetched.

##### Function

forget\_me

##### Arguments

1. email\_addr

##### Description

Forget the current email address. This will not stop the session, the existing session will be maintained. A subsequent call to get\_email\_address will fetch a new email address or the client can call set\_email\_user to set a new address. Typically, a user would want to set a new address manually after clicking the ‘forget me’ button.

##### Returns

True if successful. Note that the SUBSCR cookie will be deleted after making this call, however, PHPSESSID will persist.

##### Function

del\_email

##### Arguments

1. email\_ids - array or an integer, in the following format: email\_ids\[\]=425&email\_ids\[\]=426&email\_ids\[\]=427



   Where 425, 426 and 427 are the ids of emails to delete. In a HTTP request, this parameter would be encoded like this:

email\_ids%5B%5D=425&email\_ids%5B%5D=426&email\_ids%5B%5D=427

(See example PHP code below for how the $req string is generated. Another example here [http://snipplr.com/view/4444/passing-an-array-through-get-request/](http://snipplr.com/view/4444/passing-an-array-through-get-request/))

##### Description

Delete the emails from the server

##### Returns

An array of deleted email ids

##### Function

extend

##### Arguments

1. (none)

##### Description

##### Extend the email address time by 1 hour. A maximum of 2 hours can be extended.

##### Returns

An object with the following properties:

‘expired’ - true or false, indicating if the email has expired

‘email\_timestamp’ - A UNIX timestamp indicating the time of when the address was created. Can be in the future.

‘affected’ - 1 if extended successfully, 0 if not successful

### Sample client code (PHP):

The following sample code shows how to interact with the API using PHP:

require('JSON.php'); // grab your copy from [http://mike.teczno.com/json.html](http://mike.teczno.com/json.html) or change the code to use the JSON PHP extension if you have it enabled.

function api\_call($function, $params, $req\_type='POST', $decode=true) {

        $params\['ip'\] = $\_SERVER\['REMOTE\_ADDR'\];

        $params\['agent'\] = substr($\_SERVER\['HTTP\_USER\_AGENT'\], 0, 160);

        $result = null;

    if (isset($\_COOKIE\['SUBSCR'\])) {

        $toks = explode(':', $\_REQUEST\['SUBSCR'\]);

        $hash = array\_shift($toks);

        $email\_addr = array\_shift($toks);

        $email\_timestamp = array\_shift($toks);

        $params\['SUBSCR'\] = $\_COOKIE\['SUBSCR'\];

    }

        $req = 'f='.$function;

        foreach ($params as $key => $val) {

        if (is\_array($val)) {

            foreach ($val as $ak => $av) {

                $req .= '&'.$key.'%5B%5D='.urlencode($av);

            }

        } else {

            $req .= '&'.$key.'='.urlencode($val);

        }

        }

        $host = 'www.guerrillamail.com';

    if (strpos(\_\_FILE\_\_, '/dev')!==false) {

        $resource = '/dev/ajax.php';

    } else {

           $resource = '/ajax.php';

    }

//echo '<A href="http://'.$host.$resource.'?'.htmlentities($req).'">'.htmlentities($host.$resource).'?'.htmlentities($req).'</a>';

        $fp = fsockopen ($host, 80, $errno, $errstr, 10);

        if ($fp) {

                if ($req\_type=='GET') {

                        $get = $resource.'?'.$req;

                        $send  = "GET $get HTTP/1.0\\r\\n"; // dont need chunked so use HTTP/1.0

                        $send .= "Host: $host\\r\\n";

                        $send .= "User-Agent: Guerrilla Mail API (www.guerrillamail.com)\\r\\n";

                        $send .= "Referer: ".$\_SERVER\['SERVER\_NAME'\]."\\r\\n";

                        if (isset($\_SESSION\['API\_SESSION'\])) {

                                //$send .= "Cookie: PHPSESSID=".$\_SESSION\['API\_SESSION'\]."\\r\\n";

                        }

            $send .= "Cookie: PHPSESSID=".session\_id()."\\r\\n";

                        $send .= "Content-Type: text/xml\\r\\n";

                        $send .= "Connection: Close\\r\\n\\r\\n";

                } else {

                        // Post the data

                        $send = "POST ".$resource." HTTP/1.0\\r\\n";

                        $send .= "Host: $host\\r\\n";

                        $send .= "User-Agent: Guerrilla Mail API (www.guerrillamail.com)\\r\\n";

                        $send .= "Referer: ".$\_SERVER\['SERVER\_NAME'\]."\\r\\n";

                        if (isset($\_SESSION\['API\_SESSION'\])) {

                                //$send .= "Cookie: PHPSESSID=".$\_SESSION\['API\_SESSION'\]."\\r\\n";

                        }

            $send .= "Cookie: PHPSESSID=".session\_id()."\\r\\n";

                        $send .= "Content-Type: application/x-www-form-urlencoded\\r\\n";

                        $send .= "Content-Length: " . strlen($req) . "\\r\\n\\r\\n";

                        $send .= $req; // post the request

                }

        //echo $send;

                if ($sent = fputs ($fp, $send, strlen($send)))  {  // do the request

                        // skip headers... parse cookies

                        while (!feof($fp)) { // skip the header

                                $res = fgets ($fp);

                                if (preg\_match ('#Set-Cookie: PHPSESSID=(.+?);#', $res, $m)) {

                                        // extracted the PHP session ID

                                        // so that we can maintain a session between the client/server

                                        $\_SESSION\['API\_SESSION'\] = $m\[1\];

                                }

                // grab the SUBSCR cookie from the reply and set to the client

                                if (preg\_match ('#Set-Cookie: (SUBSCR=.+)#', $res, $m)) {

                                        $data = explode(';', $m\[1\]);

                                        foreach ($data as $item) {

                                                $pair = explode('=', $item);

                                                if (trim($pair\[0\])=='expires') {

                                                        // needs to be in a unix timestamp

                                                        $cookie\[trim($pair\[0\])\] = strtotime(trim(urldecode($pair\[1\])));

                                                } else {

                                                        $cookie\[trim($pair\[0\])\] = trim(urldecode($pair\[1\]));

                                                }

                                        }

                                        if ($\_SERVER\['HTTP\_HOST'\]=='localhost') {

                                                $host = $\_SERVER\['HTTP\_HOST'\];

                                        } else {

                                                $host = '.'.str\_replace('.www', '', $\_SERVER\['HTTP\_HOST'\]);

                                        }

                                        if (setcookie('SUBSCR', $cookie\['SUBSCR'\], $cookie\['expires'\], '/', $host)) { // , $host

                                                //echo 'cookie set';

                                        }

                                }

                                if (strcmp($res, "\\r\\n")===0) break;

                        }

                }

                $buffer = '';

                if ($sent) {

                        while(!feof($fp)) {

                                $buffer .= fread($fp, 1024);

                        }

                        $JSON = new Services\_JSON();

                        if ($decode) {

                                $result = $JSON->decode($buffer);

                        } else {

                                $result = $buffer;

                        }

                }

                if ($fp) {

                        fclose($fp);

                }

                return $result;

        } else {

                return null;

        }

}